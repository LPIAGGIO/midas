"""
Cara de particulas v2: la cara como NUBE DE DENSIDAD, no como contorno.

Referencia: @yudho.xyz "The Emergence - Experiment Number 2" (Instagram) y
../referencias/cara-particulas-referencia.png. Miles de puntos finos que se
aglutinan donde hay rasgos (ojos, cejas, boca) y quedan tenues en frente y
mejillas; respiran entre "reunidos" y "sueltos", asi la cara nunca esta fija:
se esta formando todo el tiempo.

Diferencias con la v1 (generar_cara.py):
  - v1 dibujaba ovalo/ojos/boca con trazos de ~400 puntos gordos -> emoji.
  - v2 muestrea ~2200 puntos finos de un mapa de densidad por emocion, con
    supermuestreo 2x para que queden suaves, y un ciclo de convergencia.
  - Agrega robot_2.gif: el logo de arranque, particulas dispersas que
    convergen a la cara neutral ("The Emergence" literal).

Mismas restricciones del firmware que la v1 (ver su docstring): 240x240 por el
lv_malloc unico del decoder, fondo transparente (indice del negro), disposal=2,
nombres <= 32 bytes, y la particion de 8MB con ~1MB ya ocupado.

Uso (python del venv de IDF, tiene Pillow+numpy):
  python generar_cara_v2.py --out <dir> [--size 240] [--frames 20] [--ms 70] [--n 2200]
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
BASE = (215, 235, 255)
# Colores de la paleta GIF. Menos colores = archivos mucho mas chicos (LZW) y
# menos trabajo para el decoder del ESP32. Se ajusta con --colors.
COLORES = 24
ACENTO = {
    "angry": (255, 100, 80), "crying": (130, 180, 255), "sad": (140, 165, 220),
    "loving": (255, 150, 180), "kissy": (255, 160, 190), "embarrassed": (255, 180, 160),
    "sleepy": (140, 150, 185), "thinking": (180, 205, 255), "cool": (160, 235, 255),
    "delicious": (255, 215, 140), "surprised": (255, 255, 210), "shocked": (255, 245, 210),
    "confident": (225, 240, 255), "laughing": (240, 250, 255),
}


# ----------------------------------------------------------------- densidad --
def gauss(X, Y, cx, cy, sx, sy, rot=0.0):
    """Blob gaussiano rotado. Es el ladrillo de todos los rasgos."""
    ca, sa = math.cos(rot), math.sin(rot)
    dx, dy = X - cx, Y - cy
    u = dx * ca + dy * sa
    v = -dx * sa + dy * ca
    return np.exp(-0.5 * ((u / sx) ** 2 + (v / sy) ** 2))


def arco(X, Y, cx, cy, w, curva, grosor, abierta=0.0):
    """Banda de boca: y = curva*(x/w)^2 centrada; abierta>0 agrega labio inferior."""
    x = X - cx
    dentro = np.abs(x) <= w
    yc = cy + curva * (x / w) ** 2 - curva * 0.5
    d = np.abs(Y - yc)
    band = np.exp(-0.5 * (d / grosor) ** 2) * dentro
    if abierta > 0:
        yl = yc + abierta * (1 - (x / w) ** 2)
        band = np.maximum(band, np.exp(-0.5 * ((Y - yl) / grosor) ** 2) * dentro)
        # el interior de la boca abierta queda oscuro: se resta un poco
        interior = (Y > yc) & (Y < yl) & dentro
        band = band - 0.6 * interior * np.exp(-0.5 * (np.abs(Y - (yc + yl) / 2) / max(abierta, 1)) ** 2)
    return np.clip(band, 0, None)


def mapa_densidad(emocion, S):
    """Mapa de densidad SxS (float) del que se muestrean las particulas."""
    u = S / 240.0
    ys, xs = np.mgrid[0:S, 0:S].astype(np.float32)
    X, Y = xs, ys
    c = S / 2
    D = np.zeros((S, S), np.float32)

    # Rostro: relleno tenue con borde mas denso (como el video: se ve la forma
    # entera, no solo el contorno).
    rx, ry = 82 * u, 96 * u
    r = np.sqrt(((X - c) / rx) ** 2 + ((Y - (c + 6 * u)) / ry) ** 2)
    # Primera pasada (23/09 manana): con relleno 0.22 y borde 0.9 la cara era un
    # bollo uniforme y ojos/boca no resaltaban. Se baja el relleno, se afina el
    # borde y se suben los rasgos mas abajo.
    relleno = np.clip(1 - r, 0, 1) ** 0.6 * 0.11                   # frente/mejillas
    borde = np.exp(-0.5 * ((r - 0.97) / 0.04) ** 2) * 0.65           # borde suave
    D += relleno + borde

    # Ojos y cejas
    oy = c - 20 * u
    sep = 33 * u
    ojo = dict(sx=11 * u, sy=9 * u)
    ceja_dy, ceja_rot_l, ceja_rot_r, ceja_peso = -18 * u, 0.0, 0.0, 0.55
    if emocion == "sleepy":
        ojo = dict(sx=13 * u, sy=2.2 * u); ceja_peso = 0.3
    elif emocion in ("surprised", "shocked"):
        ojo = dict(sx=14 * u, sy=14 * u); ceja_dy = -26 * u; ceja_peso = 0.7
    elif emocion == "angry":
        ojo = dict(sx=12 * u, sy=6.5 * u); ceja_dy = -13 * u; ceja_rot_l, ceja_rot_r = -0.35, 0.35; ceja_peso = 1.0
    elif emocion in ("sad", "crying", "embarrassed"):
        ojo = dict(sx=11 * u, sy=7 * u); ceja_rot_l, ceja_rot_r = 0.3, -0.3; ceja_peso = 0.7
    elif emocion in ("happy", "laughing", "funny", "delicious", "relaxed", "confident", "loving", "kissy"):
        ojo = dict(sx=12 * u, sy=7 * u)                               # ojos achinados de sonrisa
    elif emocion == "cool":
        ojo = dict(sx=17 * u, sy=7 * u); ceja_peso = 0.0             # anteojos
    for sx_, rot in ((-1, ceja_rot_l), (1, ceja_rot_r)):
        ex = c + sx_ * sep
        if emocion == "winking" and sx_ == 1:
            D += arco(X, Y, ex, oy, 12 * u, -5 * u, 2.2 * u) * 1.3
        elif emocion in ("thinking", "confused") and sx_ == 1:
            D += gauss(X, Y, ex, oy - 5 * u, ojo["sx"], ojo["sy"]) * 2.4
            D += arco(X, Y, ex, oy - 24 * u, 14 * u, -4 * u, 2.2 * u) * 0.8      # ceja levantada
            continue
        else:
            D += gauss(X, Y, ex, oy, ojo["sx"], ojo["sy"]) * 2.4
            if emocion in ("surprised", "shocked"):
                D -= gauss(X, Y, ex, oy, 5 * u, 5 * u) * 1.2                  # pupila hueca
        if ceja_peso > 0:
            D += arco(X, Y, ex, oy + ceja_dy, 15 * u, -3 * u, 2.4 * u) * ceja_peso * (1 if rot == 0 else 1.0)
            if rot != 0:
                # ceja inclinada: se aproxima con una gaussiana alargada rotada
                D += gauss(X, Y, ex, oy + ceja_dy, 15 * u, 2.4 * u, rot) * ceja_peso
    if emocion == "cool":
        D += arco(X, Y, c, oy - 1 * u, 8 * u, 0, 2 * u) * 0.9                    # puente anteojos

    # Nariz: apenas
    D += gauss(X, Y, c, c + 10 * u, 4 * u, 9 * u) * 0.15

    # Boca
    by = c + 42 * u
    g = 2.6 * u
    if emocion in ("happy", "confident", "relaxed", "winking", "cool", "delicious", "loving"):
        D += arco(X, Y, c, by, 34 * u, -14 * u, g) * 2.0
    elif emocion in ("laughing", "funny"):
        D += arco(X, Y, c, by - 4 * u, 36 * u, -12 * u, g, abierta=18 * u) * 2.0
    elif emocion in ("sad", "crying", "embarrassed"):
        D += arco(X, Y, c, by + 6 * u, 28 * u, 12 * u, g) * 1.9
    elif emocion == "angry":
        D += arco(X, Y, c, by + 4 * u, 30 * u, 6 * u, g) * 2.0
    elif emocion in ("surprised", "shocked"):
        D += (gauss(X, Y, c, by, 14 * u, 17 * u) - gauss(X, Y, c, by, 9 * u, 12 * u)).clip(0) * 2.2
    elif emocion == "kissy":
        D += (gauss(X, Y, c, by, 9 * u, 10 * u) - gauss(X, Y, c, by, 4 * u, 5 * u)).clip(0) * 2.4
    elif emocion == "thinking":
        D += arco(X, Y, c - 8 * u, by, 20 * u, 2 * u, g) * 1.8
    elif emocion == "confused":
        D += arco(X, Y, c, by, 26 * u, 0, g) * 1.7 + arco(X, Y, c + 18 * u, by + 3 * u, 8 * u, 6 * u, g) * 0.8
    elif emocion == "silly":
        D += arco(X, Y, c, by, 30 * u, -10 * u, g) * 1.9 + gauss(X, Y, c + 12 * u, by + 15 * u, 8 * u, 11 * u) * 1.2
    elif emocion == "sleepy":
        D += arco(X, Y, c, by + 2 * u, 14 * u, 2 * u, g) * 0.8
    else:  # neutral
        D += arco(X, Y, c, by, 26 * u, -3 * u, g) * 1.7

    # Lagrimas fijas (las que caen van como chispas)
    if emocion == "crying":
        for sx_ in (-1, 1):
            D += gauss(X, Y, c + sx_ * sep, oy + 22 * u, 2.5 * u, 9 * u) * 0.9

    return np.clip(D, 0, None)


def muestrear(D, n, rng):
    """n puntos con probabilidad proporcional a la densidad, con jitter subpixel."""
    p = D.ravel().astype(np.float64)
    p /= p.sum()
    idx = rng.choice(p.size, size=n, replace=True, p=p)
    S = D.shape[0]
    ys, xs = np.divmod(idx, S)
    pts = np.stack([xs + rng.uniform(-0.5, 0.5, n), ys + rng.uniform(-0.5, 0.5, n)], axis=1)
    peso = D.ravel()[idx] / D.max()
    return pts, peso


# ---------------------------------------------------------------- dinamica --
def animar(emocion, home, peso, fase, dirn, S, f, F):
    """Posicion/brillo/radio de cada particula en el frame f. Todo periodico en F."""
    c = S / 2
    u = S / 240.0
    t = f / F * 2 * math.pi
    n = len(home)

    # Ciclo de convergencia: las particulas se sueltan un poco y vuelven.
    # Los puntos de rasgos (peso alto) se mantienen mas firmes.
    A = (0.55 + 0.45 * math.sin(t - math.pi / 2))                    # 0.1 .. 1.0
    suelta = (1.0 - 0.6 * peso)[:, None] * dirn * (4.5 * u * A)
    # Flujo lento tipo remolino, distinto por particula
    flujo = np.stack([np.sin(t + fase) * 1.2 * u, np.cos(t * 1.3 + fase * 1.7) * 1.2 * u], axis=1)

    esc = 1.0
    off = np.zeros(2)
    brillo = 0.55 + 0.45 * peso                                       # rasgos mas brillantes
    rad = (1.5 + 0.9 * peso) * u

    if emocion == "neutral":
        esc = 1.0 + 0.015 * math.sin(t)
    elif emocion in ("thinking", "confused"):
        ang = 0.05 * math.sin(t)
        rel = home - c
        home = np.stack([rel[:, 0] * math.cos(ang) - rel[:, 1] * math.sin(ang),
                         rel[:, 0] * math.sin(ang) + rel[:, 1] * math.cos(ang)], axis=1) + c
    elif emocion in ("happy", "laughing", "funny", "delicious", "confident", "winking", "cool", "relaxed", "silly"):
        esc = 1.0 + 0.04 * math.sin(t)
        off = np.array([0, -3 * u * abs(math.sin(t))])
        brillo = brillo * (1.0 + 0.25 * max(0.0, math.sin(t)))
    elif emocion in ("sad", "crying", "embarrassed"):
        off = np.array([0, 4 * u * (0.5 + 0.5 * math.sin(t))])
        brillo = brillo * 0.8
    elif emocion == "angry":
        flujo = flujo * 2.5
        brillo = brillo * 1.15
    elif emocion in ("surprised", "shocked"):
        esc = 1.05 + 0.05 * math.sin(t)
        brillo = brillo * 1.2
    elif emocion == "sleepy":
        esc = 0.97
        off = np.array([0, 5 * u * (0.5 + 0.5 * math.sin(t * 0.5))])
        brillo = brillo * (0.55 + 0.15 * math.sin(t * 0.5))
    elif emocion in ("loving", "kissy"):
        esc = 1.0 + 0.035 * math.sin(2 * t)
        brillo = brillo * (1.0 + 0.3 * max(0.0, math.sin(2 * t)))

    pos = (home - c) * esc + c + off + suelta + flujo
    brillo = brillo * (0.85 + 0.15 * np.sin(t * 3 + fase * 2.3))     # centelleo
    return pos, np.clip(brillo, 0.15, 1.4), rad


def chispas(emocion, S, f, F):
    c = S / 2
    u = S / 240.0
    t = f / F
    out = []
    if emocion == "thinking":
        for k in range(3):
            ph = (t + k / 3) % 1.0
            out.append((c + 58 * u + 14 * u * k, c - 72 * u - 55 * u * ph, 0.9 - 0.7 * ph, (2.4 - k * 0.4) * u))
    elif emocion == "sleepy":
        for k in range(3):
            ph = (t * 0.6 + k / 3) % 1.0
            out.append((c + 64 * u + 10 * u * math.sin(ph * 6), c - 52 * u - 65 * u * ph, 0.8 - 0.7 * ph, 2.0 * u))
    elif emocion == "crying":
        for k in range(8):
            ph = (t + k / 8) % 1.0
            sx = -1 if k % 2 else 1
            out.append((c + sx * 33 * u + 1.5 * u * k, c + 2 * u + 65 * u * ph, 0.9 - 0.6 * ph, 1.8 * u))
    elif emocion in ("surprised", "shocked"):
        for k in range(16):
            a = k / 16 * 2 * math.pi
            r = 98 * u + 26 * u * t
            out.append((c + r * math.cos(a), c + 6 * u + r * 1.15 * math.sin(a), 1.0 - t, 1.6 * u))
    elif emocion in ("loving", "kissy"):
        for k in range(5):
            ph = (t + k / 5) % 1.0
            out.append((c - 90 * u + 45 * u * k + 8 * u * math.sin(ph * 5), c - 82 * u - 38 * u * ph, 1.0 - ph, 2.4 * u))
    return out


# --------------------------------------------------------------- render ------
def render_frame(S, pos, brillo, rad, extra, base, glow, ss=2):
    """Dibuja a ss x y reduce con LANCZOS: puntos finos y suaves, sin aliasing."""
    W = S * ss
    img = Image.new("RGB", (W, W), (0, 0, 0))
    d = ImageDraw.Draw(img)
    P = pos * ss
    R = rad * ss
    # halos (tenues) primero
    for (x, y), b, r in zip(P, brillo, R):
        bb = min(1.0, b) * 0.9
        rr = r * 2.4
        d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=tuple(int(v * bb) for v in glow))
    for (x, y, b, r) in extra:
        rr = r * ss * 2.4
        d.ellipse([x * ss - rr, y * ss - rr, x * ss + rr, y * ss + rr], fill=tuple(int(v * min(1.0, b)) for v in glow))
    # nucleos
    for (x, y), b, r in zip(P, brillo, R):
        bb = min(1.0, b)
        d.ellipse([x - r, y - r, x + r, y + r], fill=tuple(min(255, int(v * bb)) for v in base))
    for (x, y, b, r) in extra:
        rr = r * ss
        d.ellipse([x * ss - rr, y * ss - rr, x * ss + rr, y * ss + rr], fill=tuple(min(255, int(v * min(1.0, b))) for v in base))
    return img.resize((S, S), Image.LANCZOS)


def a_gif(frames, path, ms):
    """Cuantiza, marca el negro como transparente y guarda con disposal=2."""
    q = []
    for fr in frames:
        p = fr.quantize(colors=COLORES, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
        pal = p.getpalette()
        negro = next((k for k in range(len(pal) // 3) if pal[3 * k:3 * k + 3] == [0, 0, 0]), None)
        if negro is None:
            pal[0:3] = [0, 0, 0]
            p.putpalette(pal)
            negro = 0
        p.info["transparency"] = negro
        q.append(p)
    q[0].save(path, save_all=True, append_images=q[1:], loop=0, duration=ms,
              disposal=2, optimize=False, transparency=q[0].info["transparency"])
    return os.path.getsize(path)


def generar(emocion, S, F, ms, n, out_dir, seed=11):
    rng = np.random.default_rng(seed + EMOCIONES.index(emocion))
    D = mapa_densidad(emocion, S)
    home, peso = muestrear(D, n, rng)
    fase = rng.uniform(0, 2 * math.pi, n)
    ang = rng.uniform(0, 2 * math.pi, n)
    dirn = np.stack([np.cos(ang), np.sin(ang)], axis=1) * rng.uniform(0.3, 1.0, n)[:, None]
    # Acentos a mitad de camino del blanco-azul: puros quedaban un bollo amarillo
    # (surprised) o rojo (angry) en vez de una cara con un tinte.
    base = tuple(int(0.5 * a + 0.5 * b) for a, b in zip(ACENTO.get(emocion, BASE), BASE))
    glow = tuple(int(v * 0.26) for v in base)
    frames = [render_frame(S, *animar(emocion, home, peso, fase, dirn, S, f, F), chispas(emocion, S, f, F), base, glow)
              for f in range(F)]
    return a_gif(frames, os.path.join(out_dir, f"{emocion}.gif"), ms)


def generar_emergence(S, F, ms, n, out_dir, seed=99):
    """robot_2.gif (logo de arranque): del caos a la cara neutral y se mantiene."""
    rng = np.random.default_rng(seed)
    D = mapa_densidad("neutral", S)
    home, peso = muestrear(D, n, rng)
    inicio = rng.uniform(0, S, (n, 2))                              # dispersas por toda la pantalla
    fase = rng.uniform(0, 2 * math.pi, n)
    glow = tuple(int(v * 0.26) for v in BASE)
    frames = []
    for f in range(F):
        t = f / (F - 1)
        k = min(1.0, t / 0.7)                                       # converge en el 70% del loop
        k = k * k * (3 - 2 * k)                                     # ease in-out
        ruido = np.stack([np.sin(t * 6 + fase), np.cos(t * 5 + fase * 1.3)], axis=1) * (1 - k) * 6
        pos = inicio * (1 - k) + home * k + ruido
        brillo = np.clip(0.35 + 0.65 * k * (0.55 + 0.45 * peso) + 0.1 * np.sin(fase + t * 9), 0.15, 1.2)
        rad = (1.3 + 1.0 * peso * k) * (S / 240.0)
        frames.append(render_frame(S, pos, brillo, rad, [], BASE, glow))
    return a_gif(frames, os.path.join(out_dir, "robot_2.gif"), ms)


def main():
    global COLORES
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    ap.add_argument("--size", type=int, default=240)
    ap.add_argument("--frames", type=int, default=20)
    ap.add_argument("--ms", type=int, default=70)
    ap.add_argument("--n", type=int, default=2200, help="particulas por cara")
    ap.add_argument("--solo", nargs="*")
    ap.add_argument("--colors", type=int, default=COLORES, help="colores de la paleta GIF (menos = mas chico)")
    a = ap.parse_args()
    COLORES = a.colors
    os.makedirs(a.out, exist_ok=True)
    total = 0
    lista = a.solo or (EMOCIONES + ["robot_2"])
    for e in lista:
        if e == "robot_2":
            sz = generar_emergence(a.size, max(a.frames, 24), a.ms, a.n, a.out)
        else:
            sz = generar(e, a.size, a.frames, a.ms, a.n, a.out)
        total += sz
        print(f"  {e:<12} {sz / 1024:7.1f} KB", flush=True)
    print(f"TOTAL {total / 1024 / 1024:.2f} MB en {len(lista)} GIFs de {a.size}x{a.size}, {a.frames} frames, {a.n} particulas")


if __name__ == "__main__":
    main()
