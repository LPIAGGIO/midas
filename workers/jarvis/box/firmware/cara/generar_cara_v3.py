"""
Cara de particulas v3: RETRATO PUNTEADO, no emoji.

Lo que LP mostro (foto del LILYGO y el video de @yudho.xyz) no es un dibujo con
puntos: es un rostro real iluminado, muestreado en particulas. Los puntos estan
donde la luz pega (frente, pomulos, tabique, menton, labio inferior) y faltan
donde hay sombra (cuencas, bajo la nariz, bajo el labio, bordes que se hunden).
Las v1 y v2 dibujaban ovalo+ojos+boca: por mas puntos que tuvieran, eran un
emoji.

Como se construye aca:
  1. Una CABEZA en 3D aproximada con elipsoides (craneo, frente, pomulos, nariz,
     arcos de las cejas, menton, labios, cuencas hundidas). De cada pixel sale
     una altura z(x,y) = max de los elipsoides (una "escultura").
  2. Se calcula la NORMAL de esa superficie y se ilumina con una luz desde
     arriba-izquierda (Lambert) mas un poco de luz de contorno. Eso da L(x,y),
     la luminancia: la frente y los pomulos claros, las cuencas oscuras.
  3. Densidad = L^gamma dentro de la silueta, mas un realce por bordes (donde la
     normal gira rapido: nariz, labios, mandibula). De ahi se muestrean ~2600
     particulas finas. El resultado es un retrato de puntos, no un contorno.
  4. Las EMOCIONES son deformaciones leves de la escultura antes de iluminar:
     comisuras arriba/abajo, cejas que suben o se fruncen, cuencas que se
     abren (sorpresa) o cierran (dormido), boca que se abre (risa). La cara
     sigue siendo la misma persona.
  5. Movimiento: las particulas fluyen sobre la superficie (ruido lento) y
     centellean; un ciclo suave de "reunirse/soltarse". robot_2 (arranque):
     del polvo disperso emerge el rostro.

Mismas restricciones del firmware (ver generar_cara.py): 240x240, fondo
transparente (indice del negro), disposal=2, <=32 bytes de nombre, y que los 22
entren en ~6 MB. Pocos colores en la paleta para que LZW comprima.

Uso (python del venv de IDF):
  python generar_cara_v3.py --out <dir> [--size 240] [--frames 18] [--ms 75] [--n 2600] [--colors 20]
"""

import argparse
import math
import os

import numpy as np
from PIL import Image, ImageDraw

EMOCIONES = [
    "angry", "confident", "confused", "cool", "crying", "delicious", "embarrassed",
    "funny", "happy", "kissy", "laughing", "loving", "neutral", "relaxed", "sad",
    "shocked", "silly", "sleepy", "surprised", "thinking", "winking",
]
BASE = (222, 236, 255)
TINTE = {  # tinte leve por emocion (se mezcla 35% con BASE)
    "angry": (255, 120, 100), "crying": (150, 190, 255), "sad": (160, 180, 230),
    "loving": (255, 170, 195), "kissy": (255, 175, 200), "embarrassed": (255, 190, 175),
    "sleepy": (150, 160, 200), "thinking": (190, 210, 255), "cool": (170, 235, 255),
    "delicious": (255, 220, 160), "surprised": (255, 250, 220), "shocked": (255, 245, 220),
}
COLORES = 20


# ------------------------------------------------------------- escultura ----
def elipsoide(X, Y, cx, cy, rx, ry, h, rot=0.0, p=2.0):
    """Bulto SUAVE (gaussiano generalizado): h * exp(-((u/rx)^p + (v/ry)^p)).

    La primera version usaba elipsoides con borde duro (sqrt) compuestos con
    max(): al iluminar, cada borde daba un aro y la cara parecia una mascara de
    pelotas pegadas (nariz en franjas, pomulos como bolas). Los bultos
    gaussianos no tienen borde y se SUMAN, asi la superficie es continua.
    """
    ca, sa = math.cos(rot), math.sin(rot)
    dx, dy = X - cx, Y - cy
    u = dx * ca + dy * sa
    v = -dx * sa + dy * ca
    return h * np.exp(-((np.abs(u) / rx) ** p + (np.abs(v) / ry) ** p))


def desenfocar(Z, sigma):
    """Desenfoque gaussiano separable con numpy (sin scipy)."""
    if sigma <= 0:
        return Z
    r = int(3 * sigma)
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    Zp = np.pad(Z, r, mode="edge")
    Zx = np.apply_along_axis(lambda m: np.convolve(m, k, mode="valid"), 1, Zp)
    Zy = np.apply_along_axis(lambda m: np.convolve(m, k, mode="valid"), 0, Zx)
    return Zy.astype(Z.dtype)


def cabeza(emocion, S):
    """Mapa de altura z(x,y) de la cabeza con la emocion aplicada, y la silueta."""
    u = S / 240.0
    ys, xs = np.mgrid[0:S, 0:S].astype(np.float32)
    X, Y = xs, ys
    c = S / 2

    # --- parametros de expresion (todo en unidades u) ------------------------
    ceja_dy = 0.0        # + baja las cejas, - las sube
    ceja_rot = 0.0       # + frunce (interior abajo)
    ojo_ap = 1.0         # apertura de las cuencas (1 normal, 0.15 cerrado, 1.6 abierto)
    comisura = 0.0       # + sonrie, - triste (px de subida de las comisuras)
    boca_ap = 0.0        # apertura de la boca (px)
    boca_w = 1.0         # ancho relativo de la boca
    ladeo = 0.0          # rotacion de toda la cabeza (rad)
    ceja_asim = 0.0      # una ceja mas alta que la otra
    # Expresiones mas marcadas que en la primera pasada: a 240 px y hechas de
    # puntos, un cambio sutil de escultura no se lee; la hoja de contacto
    # mostraba 21 caras casi iguales.
    if emocion in ("happy", "confident", "relaxed", "delicious", "loving", "cool"):
        comisura, ojo_ap = 11 * u, 0.6
    elif emocion in ("laughing", "funny"):
        comisura, boca_ap, ojo_ap = 12 * u, 16 * u, 0.4
    elif emocion == "winking":
        comisura, ojo_ap = 9 * u, 0.8
    elif emocion in ("sad", "crying", "embarrassed"):
        comisura, ceja_rot, ceja_dy = -11 * u, -0.35, -3 * u
    elif emocion == "angry":
        comisura, ceja_rot, ceja_dy, ojo_ap = -6 * u, 0.6, 8 * u, 0.7
    elif emocion in ("surprised", "shocked"):
        ojo_ap, ceja_dy, boca_ap, boca_w = 2.0, -9 * u, 14 * u, 0.55
    elif emocion == "sleepy":
        ojo_ap, ceja_dy, comisura = 0.1, 3 * u, -3 * u
    elif emocion in ("thinking", "confused"):
        ceja_asim, ladeo, comisura = 8 * u, 0.07, -3 * u
    elif emocion == "kissy":
        boca_w, boca_ap, ojo_ap = 0.4, 7 * u, 0.6
    elif emocion == "silly":
        comisura, ladeo, boca_ap = 11 * u, -0.06, 10 * u

    # --- rotacion (ladeo) del sistema de coordenadas ----------------------
    if ladeo:
        ca, sa = math.cos(ladeo), math.sin(ladeo)
        dx, dy = X - c, Y - c
        X = c + dx * ca - dy * sa
        Y = c + dx * sa + dy * ca

    # --- craneo: UN volumen grande y suave; todo lo demas son modulaciones
    # chicas encima (una cara real es 90% craneo y 10% rasgos). Se SUMA, no se
    # toma el maximo, para que no haya aristas entre volumenes.
    craneo = elipsoide(X, Y, c, c + 4 * u, 70 * u, 88 * u, 60 * u, p=2.6)
    sil = craneo > 60 * u * math.exp(-1.0)          # silueta: donde el craneo tiene altura real
    Z = craneo.copy()
    Z += elipsoide(X, Y, c, c - 40 * u, 48 * u, 34 * u, 7 * u)              # frente
    for sx in (-1, 1):
        Z += elipsoide(X, Y, c + sx * 44 * u, c + 6 * u, 20 * u, 16 * u, 9 * u)   # pomulos
    Z += elipsoide(X, Y, c, c + 72 * u, 20 * u, 14 * u, 8 * u)              # menton
    for sx in (-1, 1):                                                       # arcos de las cejas
        dy = ceja_dy - (ceja_asim if sx == 1 else 0.0)
        Z += elipsoide(X, Y, c + sx * 30 * u, c - 30 * u + dy, 20 * u, 5 * u, 9 * u, rot=-sx * ceja_rot, p=2.4)
    Z += elipsoide(X, Y, c, c + 4 * u, 6 * u, 26 * u, 14 * u, p=2.2)         # tabique
    Z += elipsoide(X, Y, c, c + 24 * u, 10 * u, 7 * u, 11 * u)               # punta de la nariz
    by = c + 44 * u
    Z += elipsoide(X, Y, c, by - 3 * u - boca_ap * 0.5, 20 * u * boca_w, 3.5 * u, 8 * u, p=2.4)   # labio sup
    Z += elipsoide(X, Y, c, by + 6 * u + boca_ap * 0.5, 17 * u * boca_w, 4.5 * u, 9 * u, p=2.4)   # labio inf

    # --- hundimientos (restan): cuencas, boca abierta, bajo nariz, bajo labio
    for sx in (-1, 1):
        ap = 0.15 if (emocion == "winking" and sx == 1) else ojo_ap
        Z -= elipsoide(X, Y, c + sx * 30 * u, c - 17 * u, 12.5 * u, 7 * u * ap + 1.5 * u, 22 * u, p=2.4)
    if boca_ap > 0:
        Z -= elipsoide(X, Y, c, by + 1.5 * u, 14 * u * boca_w, boca_ap * 0.5, 14 * u, p=2.4)
    Z -= elipsoide(X, Y, c, c + 34 * u, 8 * u, 3 * u, 7 * u)                 # bajo la nariz
    Z -= elipsoide(X, Y, c, by + 14 * u, 12 * u, 3 * u, 6 * u)               # bajo el labio

    # --- comisuras: arrastre vertical suave de la zona de la boca ------------
    if comisura:
        xr = np.clip((X - c) / (22 * u * boca_w), -1, 1)
        peso = np.exp(-0.5 * ((Y - by) / (14 * u)) ** 2) * np.abs(xr) ** 1.5 * (np.abs(X - c) < 30 * u)
        Yi = np.clip(np.round(Y - comisura * peso).astype(int), 0, S - 1)
        Xi = np.clip(np.round(X).astype(int), 0, S - 1)
        Z = Z[Yi, Xi]

    # Piel: sin aristas. El desenfoque final es lo que hace que la luz se
    # deslice por la cara en vez de recortar cada volumen.
    Z = desenfocar(np.clip(Z, 0, None), 2.2 * u) * sil
    return Z, sil


def iluminar(Z, sil, S):
    """Lambert desde arriba-izquierda + luz de contorno. Devuelve luminancia 0..1."""
    gy, gx = np.gradient(Z)
    nx, ny, nz = -gx, -gy, np.ones_like(Z) * 1.15
    norm = np.sqrt(nx * nx + ny * ny + nz * nz)
    nx, ny, nz = nx / norm, ny / norm, nz / norm
    luz = np.array([-0.45, -0.7, 0.55]); luz /= np.linalg.norm(luz)
    L = np.clip(nx * luz[0] + ny * luz[1] + nz * luz[2], 0, 1)
    # luz de contorno (rim) tenue para que el borde no desaparezca del todo
    rim = np.clip(1 - nz, 0, 1) ** 2 * 0.35
    L = np.clip(L * 0.85 + rim, 0, 1) * sil
    return L


def densidad(emocion, S):
    Z, sil = cabeza(emocion, S)
    L = iluminar(Z, sil, S)
    # bordes: donde la superficie gira rapido (nariz, labios, mandibula)
    gy, gx = np.gradient(L)
    borde = np.clip(np.sqrt(gx * gx + gy * gy) * 6.0, 0, 1)
    # gamma alto = mas contraste: lo iluminado junta puntos, la sombra queda casi
    # vacia (asi es la referencia). Con 1.6 la frente quedaba pareja y densa.
    D = (L ** 3.0) + borde * 0.8
    # dejar apenas puntos tenues en toda la silueta (piel)
    D = D + sil * 0.008
    return np.clip(D, 0, None) * sil


def muestrear(D, n, rng):
    p = D.ravel().astype(np.float64); p /= p.sum()
    idx = rng.choice(p.size, size=n, replace=True, p=p)
    S = D.shape[0]
    ys, xs = np.divmod(idx, S)
    pts = np.stack([xs + rng.uniform(-0.5, 0.5, n), ys + rng.uniform(-0.5, 0.5, n)], axis=1)
    peso = (D.ravel()[idx] / D.max()) ** 0.7
    return pts, peso


# ---------------------------------------------------------------- dinamica --
def animar(emocion, home, peso, fase, dirn, S, f, F):
    c = S / 2
    u = S / 240.0
    t = f / F * 2 * math.pi
    A = 0.5 + 0.5 * math.sin(t - math.pi / 2)                      # 0..1 reunir/soltar
    suelta = (1.0 - 0.7 * peso)[:, None] * dirn * (3.0 * u * A)
    flujo = np.stack([np.sin(t + fase) * 0.9 * u, np.cos(t * 1.3 + fase * 1.7) * 0.9 * u], axis=1)
    esc, off = 1.0, np.zeros(2)
    # En la hoja de contacto las 21 caras quedaron grises: la base 0.30 era muy
    # baja. Se sube el piso y se mantiene el rango hacia las luces.
    # LP (23/09): "los puntos tienen que ser mas chiquitos, menos de la mitad".
    # Nucleos de ~0.5-0.8 px (con supermuestreo 2x quedan como puntos de 1 px
    # nitidos) y mas particulas para no perder cobertura. Casi blancos.
    brillo = 0.7 + 0.5 * peso
    rad = (0.42 + 0.3 * peso) * u
    if emocion == "neutral":
        esc = 1.0 + 0.012 * math.sin(t)
    elif emocion in ("happy", "laughing", "funny", "delicious", "confident", "winking", "cool", "relaxed", "silly"):
        off = np.array([0, -2.5 * u * abs(math.sin(t))]); brillo = brillo * (1 + 0.2 * max(0.0, math.sin(t)))
    elif emocion in ("sad", "crying", "embarrassed"):
        off = np.array([0, 3 * u * (0.5 + 0.5 * math.sin(t))]); brillo = brillo * 0.8
    elif emocion == "angry":
        flujo = flujo * 2.2; brillo = brillo * 1.1
    elif emocion in ("surprised", "shocked"):
        esc = 1.03 + 0.03 * math.sin(t); brillo = brillo * 1.15
    elif emocion == "sleepy":
        off = np.array([0, 4 * u * (0.5 + 0.5 * math.sin(t * 0.5))]); brillo = brillo * (0.55 + 0.15 * math.sin(t * 0.5))
    elif emocion in ("loving", "kissy"):
        esc = 1.0 + 0.025 * math.sin(2 * t); brillo = brillo * (1 + 0.25 * max(0.0, math.sin(2 * t)))
    elif emocion in ("thinking", "confused"):
        brillo = brillo * (0.9 + 0.1 * math.sin(t * 2))
    pos = (home - c) * esc + c + off + suelta + flujo
    brillo = brillo * (0.88 + 0.12 * np.sin(t * 3 + fase * 2.3))
    return pos, np.clip(brillo, 0.12, 1.3), rad


def chispas(emocion, S, f, F):
    c = S / 2; u = S / 240.0; t = f / F; out = []
    if emocion == "thinking":
        for k in range(3):
            ph = (t + k / 3) % 1.0
            out.append((c + 60 * u + 12 * u * k, c - 74 * u - 50 * u * ph, 0.9 - 0.7 * ph, (2.2 - k * 0.4) * u))
    elif emocion == "sleepy":
        for k in range(3):
            ph = (t * 0.6 + k / 3) % 1.0
            out.append((c + 66 * u + 9 * u * math.sin(ph * 6), c - 56 * u - 60 * u * ph, 0.8 - 0.7 * ph, 1.9 * u))
    elif emocion == "crying":
        for k in range(8):
            ph = (t + k / 8) % 1.0; sx = -1 if k % 2 else 1
            out.append((c + sx * 30 * u + 1.2 * u * k, c - 6 * u + 60 * u * ph, 0.9 - 0.6 * ph, 1.6 * u))
    elif emocion in ("loving", "kissy"):
        for k in range(5):
            ph = (t + k / 5) % 1.0
            out.append((c - 88 * u + 44 * u * k + 7 * u * math.sin(ph * 5), c - 84 * u - 34 * u * ph, 1.0 - ph, 2.2 * u))
    return out


# ------------------------------------------------------------------ render --
def render_frame(S, pos, brillo, rad, extra, base, glow, ss=2):
    W = S * ss
    img = Image.new("RGB", (W, W), (0, 0, 0))
    d = ImageDraw.Draw(img)
    P, R = pos * ss, rad * ss
    for (x, y), b, r in zip(P, brillo, R):
        rr = r * 1.6; bb = min(1.0, b) * 0.45
        d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=tuple(int(v * bb) for v in glow))
    for (x, y, b, r) in extra:
        rr = r * ss * 1.6
        d.ellipse([x * ss - rr, y * ss - rr, x * ss + rr, y * ss + rr], fill=tuple(int(v * min(1.0, b)) for v in glow))
    for (x, y), b, r in zip(P, brillo, R):
        bb = min(1.0, b)
        d.ellipse([x - r, y - r, x + r, y + r], fill=tuple(min(255, int(v * bb)) for v in base))
    for (x, y, b, r) in extra:
        rr = r * ss
        d.ellipse([x * ss - rr, y * ss - rr, x * ss + rr, y * ss + rr], fill=tuple(min(255, int(v * min(1.0, b))) for v in base))
    return img.resize((S, S), Image.LANCZOS)


def a_gif(frames, path, ms):
    q = []
    for fr in frames:
        p = fr.quantize(colors=COLORES, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
        pal = p.getpalette()
        negro = next((k for k in range(len(pal) // 3) if pal[3 * k:3 * k + 3] == [0, 0, 0]), None)
        if negro is None:
            pal[0:3] = [0, 0, 0]; p.putpalette(pal); negro = 0
        p.info["transparency"] = negro
        q.append(p)
    q[0].save(path, save_all=True, append_images=q[1:], loop=0, duration=ms,
              disposal=2, optimize=False, transparency=q[0].info["transparency"])
    return os.path.getsize(path)


def color_de(emocion):
    t = TINTE.get(emocion)
    if not t:
        return BASE
    return tuple(int(0.65 * b + 0.35 * a) for a, b in zip(t, BASE))


def generar(emocion, S, F, ms, n, out_dir, seed=23):
    rng = np.random.default_rng(seed + EMOCIONES.index(emocion))
    D = densidad(emocion, S)
    home, peso = muestrear(D, n, rng)
    fase = rng.uniform(0, 2 * math.pi, n)
    ang = rng.uniform(0, 2 * math.pi, n)
    dirn = np.stack([np.cos(ang), np.sin(ang)], axis=1) * rng.uniform(0.3, 1.0, n)[:, None]
    base = color_de(emocion)
    glow = tuple(int(v * 0.22) for v in base)
    frames = [render_frame(S, *animar(emocion, home, peso, fase, dirn, S, f, F), chispas(emocion, S, f, F), base, glow)
              for f in range(F)]
    return a_gif(frames, os.path.join(out_dir, f"{emocion}.gif"), ms)


def generar_emergence(S, F, ms, n, out_dir, seed=99):
    rng = np.random.default_rng(seed)
    D = densidad("neutral", S)
    home, peso = muestrear(D, n, rng)
    inicio = rng.uniform(0, S, (n, 2))
    fase = rng.uniform(0, 2 * math.pi, n)
    glow = tuple(int(v * 0.22) for v in BASE)
    frames = []
    for f in range(F):
        t = f / (F - 1)
        k = min(1.0, t / 0.7); k = k * k * (3 - 2 * k)
        ruido = np.stack([np.sin(t * 6 + fase), np.cos(t * 5 + fase * 1.3)], axis=1) * (1 - k) * 6
        pos = inicio * (1 - k) + home * k + ruido
        brillo = np.clip(0.35 + 0.85 * k * (0.5 + 0.5 * peso) + 0.1 * np.sin(fase + t * 9), 0.12, 1.2)
        rad = (0.45 + 0.35 * peso * k) * (S / 240.0)
        frames.append(render_frame(S, pos, brillo, rad, [], BASE, glow))
    return a_gif(frames, os.path.join(out_dir, "robot_2.gif"), ms)


def exportar_mapas(out_dir, S=240):
    """Guarda la luminancia de la cabeza neutral para revisar la escultura sin particulas."""
    Z, sil = cabeza("neutral", S)
    L = iluminar(Z, sil, S)
    Image.fromarray((L * 255).astype(np.uint8)).save(os.path.join(out_dir, "_debug_luz.png"))
    D = densidad("neutral", S)
    Image.fromarray((D / D.max() * 255).astype(np.uint8)).save(os.path.join(out_dir, "_debug_densidad.png"))


def main():
    global COLORES
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    ap.add_argument("--size", type=int, default=240)
    ap.add_argument("--frames", type=int, default=18)
    ap.add_argument("--ms", type=int, default=75)
    ap.add_argument("--n", type=int, default=5000)
    ap.add_argument("--colors", type=int, default=COLORES)
    ap.add_argument("--solo", nargs="*")
    ap.add_argument("--debug", action="store_true", help="exporta los mapas de luz y densidad")
    a = ap.parse_args()
    COLORES = a.colors
    os.makedirs(a.out, exist_ok=True)
    if a.debug:
        exportar_mapas(a.out, a.size)
    total = 0
    lista = a.solo or (EMOCIONES + ["robot_2"])
    for e in lista:
        sz = generar_emergence(a.size, max(a.frames, 24), a.ms, a.n, a.out) if e == "robot_2" \
            else generar(e, a.size, a.frames, a.ms, a.n, a.out)
        total += sz
        print(f"  {e:<12} {sz / 1024:7.1f} KB", flush=True)
    print(f"TOTAL {total / 1024 / 1024:.2f} MB en {len(lista)} GIFs de {a.size}x{a.size}, {a.frames} frames, {a.n} particulas, {COLORES} colores")


if __name__ == "__main__":
    main()
