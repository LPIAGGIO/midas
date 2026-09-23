"""
Cara de particulas para la caja de Jarvis.

Genera los 21 GIFs de emocion que el firmware xiaozhi busca por nombre
(neutral.gif, thinking.gif, happy.gif, ...). Puntos blancos sobre fondo negro
que forman un rostro y se mueven segun el estado: respiran en reposo, se
concentran pensando, se expanden contentos, se caen dormidos.

Referencia visual: ../referencias/cara-particulas-referencia.png

Restricciones que salen del firmware (verificadas en el codigo, 22/09/2026):
  - El decoder GIF propio (gifdec) hace UN lv_malloc de 5*w*h bytes + otro de
    4*w*h para el canvas. Con LV_MEM_SIZE=1MB ningun bloque puede pasar de
    ~1MB: 240x240 usa ~290KB + ~230KB y entra comodo. 360x360 entraria justo y
    no vale el riesgo: el emoji va arriba y el texto abajo, 240 luce bien.
  - El widget se alinea TOP_MID a ~28px del borde; abajo va la frase.
  - La particion de assets es de 8MB y ya lleva ~1MB (modelo wake word +
    fuente). Los 21 GIFs tienen que entrar en lo que queda: fondo negro y
    pocos colores comprimen muy bien en LZW; se imprime el total al final.
  - El nombre de archivo no puede pasar 32 bytes. Todos sobran.

Uso (con el python del venv de IDF, que ya tiene Pillow y numpy):
  python generar_cara.py --out <dir> [--size 240] [--frames 16] [--ms 80]
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

# Colores: base azul-blanco tipo HUD; acento por emocion (r, g, b).
BASE = (205, 228, 255)
GLOW = (40, 70, 120)
ACENTO = {
    "angry": (255, 90, 70), "crying": (120, 170, 255), "sad": (120, 150, 210),
    "loving": (255, 140, 170), "kissy": (255, 150, 180), "embarrassed": (255, 170, 150),
    "sleepy": (130, 140, 170), "thinking": (170, 200, 255), "cool": (150, 230, 255),
    "delicious": (255, 210, 130), "surprised": (255, 255, 200), "shocked": (255, 240, 200),
}


def anillo(cx, cy, rx, ry, n, ancho, rng, a0=0.0, a1=2 * math.pi):
    """n puntos sobre una banda eliptica (arco entre a0 y a1)."""
    t = rng.uniform(a0, a1, n)
    r = 1.0 + rng.uniform(-ancho, ancho, n)
    return np.stack([cx + rx * r * np.cos(t), cy + ry * r * np.sin(t)], axis=1)


def relleno(cx, cy, rx, ry, n, rng):
    """n puntos dentro de una elipse (para los ojos)."""
    t = rng.uniform(0, 2 * math.pi, n)
    r = np.sqrt(rng.uniform(0, 1, n))
    return np.stack([cx + rx * r * np.cos(t), cy + ry * r * np.sin(t)], axis=1)


def boca(cx, cy, w, curva, n, rng, abierta=0.0):
    """Arco de boca: curva>0 sonrie, <0 triste, abierta>0 agrega el labio inferior."""
    x = rng.uniform(-w, w, n)
    y = curva * (x / w) ** 2 - curva * 0.5 + rng.uniform(-2, 2, n)
    pts = [np.stack([cx + x, cy + y], axis=1)]
    if abierta > 0:
        x2 = rng.uniform(-w * 0.8, w * 0.8, n // 2)
        y2 = y[: n // 2] * 0.3 + abierta * (1 - (x2 / (w * 0.8)) ** 2)
        pts.append(np.stack([cx + x2, cy + y2], axis=1))
    return np.concatenate(pts)


def cara_objetivo(emocion, S, rng):
    """Puntos destino de las particulas para una emocion, en un lienzo SxS."""
    c = S / 2
    u = S / 240.0  # escala respecto del diseno base de 240
    pts = []

    # Ovalo de la cara: banda de puntos, ligeramente mas ancho arriba.
    pts.append(anillo(c, c + 4 * u, 78 * u, 92 * u, 170, 0.035, rng))

    # Ojos: forma segun emocion.
    ojo_y = c - 22 * u
    sep = 32 * u
    if emocion == "sleepy":
        for sx in (-1, 1):
            pts.append(boca(c + sx * sep, ojo_y, 14 * u, 3 * u, 22, rng))          # rayas cerradas
    elif emocion == "winking":
        pts.append(relleno(c - sep, ojo_y, 11 * u, 11 * u, 60, rng))
        pts.append(boca(c + sep, ojo_y, 12 * u, -4 * u, 22, rng))                # guino
    elif emocion in ("surprised", "shocked"):
        for sx in (-1, 1):
            pts.append(anillo(c + sx * sep, ojo_y, 15 * u, 15 * u, 45, 0.06, rng))
            pts.append(relleno(c + sx * sep, ojo_y, 5 * u, 5 * u, 14, rng))
    elif emocion == "angry":
        for sx in (-1, 1):
            e = relleno(c + sx * sep, ojo_y, 12 * u, 8 * u, 55, rng)
            # cejas caidas hacia adentro
            ceja = boca(c + sx * sep, ojo_y - 16 * u, 14 * u, sx * 5 * u, 18, rng)
            pts += [e, ceja]
    elif emocion in ("thinking", "confused"):
        pts.append(relleno(c - sep, ojo_y, 10 * u, 9 * u, 50, rng))
        pts.append(relleno(c + sep, ojo_y - 5 * u, 11 * u, 10 * u, 55, rng))   # una ceja arriba
        pts.append(boca(c + sep, ojo_y - 20 * u, 13 * u, -3 * u, 16, rng))
    elif emocion == "cool":
        for sx in (-1, 1):
            pts.append(boca(c + sx * sep, ojo_y, 17 * u, 2 * u, 30, rng))         # anteojos oscuros
            pts.append(boca(c + sx * sep, ojo_y + 8 * u, 17 * u, -2 * u, 26, rng))
        pts.append(boca(c, ojo_y + 2 * u, 8 * u, 0, 10, rng))                      # puente
    elif emocion in ("loving", "kissy"):
        for sx in (-1, 1):
            cx_ = c + sx * sep
            pts.append(relleno(cx_ - 5 * u, ojo_y - 3 * u, 6 * u, 6 * u, 20, rng))
            pts.append(relleno(cx_ + 5 * u, ojo_y - 3 * u, 6 * u, 6 * u, 20, rng))
            pts.append(relleno(cx_, ojo_y + 5 * u, 9 * u, 7 * u, 26, rng))       # corazon aprox
    else:
        for sx in (-1, 1):
            pts.append(relleno(c + sx * sep, ojo_y, 11 * u, 10 * u, 60, rng))

    # Boca segun emocion.
    by = c + 38 * u
    if emocion in ("happy", "confident", "relaxed", "winking", "cool", "delicious"):
        pts.append(boca(c, by, 34 * u, -14 * u, 60, rng))
    elif emocion in ("laughing", "funny"):
        pts.append(boca(c, by - 4 * u, 36 * u, -12 * u, 60, rng, abierta=16 * u))
    elif emocion in ("sad", "crying", "embarrassed"):
        pts.append(boca(c, by + 6 * u, 28 * u, 12 * u, 50, rng))
    elif emocion == "angry":
        pts.append(boca(c, by + 4 * u, 30 * u, 6 * u, 46, rng))
    elif emocion in ("surprised", "shocked"):
        pts.append(anillo(c, by, 14 * u, 17 * u, 50, 0.06, rng))
    elif emocion == "kissy":
        pts.append(anillo(c, by, 8 * u, 9 * u, 34, 0.08, rng))
    elif emocion == "thinking":
        pts.append(boca(c - 8 * u, by, 20 * u, 2 * u, 34, rng))                  # boca ladeada
    elif emocion == "confused":
        pts.append(boca(c, by, 26 * u, 0, 36, rng))
        pts.append(boca(c + 18 * u, by + 3 * u, 8 * u, 6 * u, 12, rng))
    elif emocion == "silly":
        pts.append(boca(c, by, 30 * u, -10 * u, 50, rng))
        pts.append(relleno(c + 12 * u, by + 14 * u, 9 * u, 12 * u, 36, rng))    # lengua
    elif emocion == "sleepy":
        pts.append(boca(c, by + 2 * u, 14 * u, 2 * u, 20, rng))
    elif emocion == "loving":
        pts.append(boca(c, by, 30 * u, -12 * u, 54, rng))
    else:  # neutral
        pts.append(boca(c, by, 26 * u, -3 * u, 40, rng))

    # Lagrimas / gotas
    if emocion == "crying":
        for sx in (-1, 1):
            xs = c + sx * sep + rng.uniform(-3 * u, 3 * u, 14)
            ys = ojo_y + 16 * u + rng.uniform(0, 40 * u, 14)
            pts.append(np.stack([xs, ys], axis=1))

    return np.concatenate(pts)


def mover(emocion, home, S, f, F, rng_fase):
    """Posicion, brillo y tamanio de cada particula en el frame f de F."""
    c = S / 2
    u = S / 240.0
    t = f / F * 2 * math.pi
    n = len(home)
    fase = rng_fase  # fase fija por particula, para que el ruido no "hierva"
    # Deriva suave (ruido pseudo-periodico)
    dx = 1.6 * u * np.sin(t + fase) + 0.8 * u * np.sin(2 * t + fase * 1.7)
    dy = 1.6 * u * np.cos(t * 1.3 + fase) + 0.8 * u * np.cos(2 * t + fase * 0.6)
    esc = 1.0
    off = np.zeros(2)
    brillo = np.full(n, 1.0)
    rad = np.full(n, 2.0 * u)

    if emocion == "neutral":
        esc = 1.0 + 0.02 * math.sin(t)                                   # respira
    elif emocion in ("thinking", "confused"):
        ang = 0.06 * math.sin(t)                                          # se ladea
        rel = home - c
        rot = np.stack([rel[:, 0] * math.cos(ang) - rel[:, 1] * math.sin(ang),
                        rel[:, 0] * math.sin(ang) + rel[:, 1] * math.cos(ang)], axis=1)
        home = rot + c
        esc = 0.97
    elif emocion in ("happy", "laughing", "funny", "delicious", "confident", "winking", "cool", "relaxed", "silly"):
        esc = 1.0 + 0.05 * math.sin(t)                                   # rebota
        off = np.array([0, -3 * u * abs(math.sin(t))])
        brillo *= 1.0 + 0.25 * max(0, math.sin(t))
    elif emocion in ("sad", "crying", "embarrassed"):
        off = np.array([0, 4 * u * (0.5 + 0.5 * math.sin(t))])            # se cae
        brillo *= 0.75
        esc = 0.98
    elif emocion == "angry":
        dx = dx * 2.2
        dy = dy * 2.2                                                    # vibra
        brillo *= 1.15
    elif emocion in ("surprised", "shocked"):
        esc = 1.06 + 0.06 * math.sin(t)                                   # se expande
        brillo *= 1.2
    elif emocion == "sleepy":
        esc = 0.96
        off = np.array([0, 6 * u * (0.5 + 0.5 * math.sin(t * 0.5))])
        brillo *= 0.55 + 0.15 * math.sin(t * 0.5)
        rad *= 0.9
    elif emocion in ("loving", "kissy"):
        esc = 1.0 + 0.04 * math.sin(2 * t)                               # latido
        brillo *= 1.0 + 0.3 * max(0, math.sin(2 * t))

    pos = (home - c) * esc + c + off + np.stack([dx, dy], axis=1)
    # Parpadeo individual sutil
    brillo = brillo * (0.85 + 0.15 * np.sin(t * 3 + fase * 2.3))
    return pos, np.clip(brillo, 0.2, 1.4), rad


def chispas(emocion, S, f, F, rng):
    """Particulas extra fuera de la cara: pensamientos, zzz, lagrimas cayendo."""
    c = S / 2
    u = S / 240.0
    t = f / F
    out = []
    if emocion == "thinking":
        for k in range(3):
            ph = (t + k / 3) % 1.0
            out.append((c + 55 * u + 14 * u * k, c - 70 * u - 60 * u * ph, 0.9 - 0.7 * ph, (2.5 - k * 0.4) * u))
    elif emocion == "sleepy":
        for k in range(3):
            ph = (t * 0.6 + k / 3) % 1.0
            out.append((c + 62 * u + 10 * u * math.sin(ph * 6), c - 50 * u - 70 * u * ph, 0.8 - 0.7 * ph, 2.2 * u))
    elif emocion == "crying":
        for k in range(6):
            ph = (t + k / 6) % 1.0
            sx = -1 if k % 2 else 1
            out.append((c + sx * 32 * u + 2 * u * k, c - 6 * u + 70 * u * ph, 0.9 - 0.6 * ph, 2.0 * u))
    elif emocion in ("surprised", "shocked"):
        for k in range(12):
            a = k / 12 * 2 * math.pi
            r = 100 * u + 30 * u * t
            out.append((c + r * math.cos(a), c + 4 * u + r * 1.15 * math.sin(a), 1.0 - t, 1.8 * u))
    elif emocion in ("loving", "kissy"):
        for k in range(4):
            ph = (t + k / 4) % 1.0
            out.append((c - 90 * u + 45 * u * k + 8 * u * math.sin(ph * 5), c - 80 * u - 40 * u * ph, 1.0 - ph, 2.6 * u))
    return out


def punto(draw, x, y, r, brillo, base, glow):
    """Particula con halo: circulo tenue grande + circulo brillante chico."""
    b = min(1.0, brillo)
    g = tuple(int(v * b) for v in glow)
    n = tuple(min(255, int(v * b)) for v in base)
    draw.ellipse([x - r * 2.2, y - r * 2.2, x + r * 2.2, y + r * 2.2], fill=g)
    draw.ellipse([x - r, y - r, x + r, y + r], fill=n)


def generar(emocion, S, F, ms, out_dir, seed=7):
    rng = np.random.default_rng(seed + EMOCIONES.index(emocion))
    home = cara_objetivo(emocion, S, rng)
    fase = rng.uniform(0, 2 * math.pi, len(home))
    base = ACENTO.get(emocion, BASE)
    glow = tuple(int(v * 0.35) for v in base)

    frames = []
    for f in range(F):
        img = Image.new("RGB", (S, S), (0, 0, 0))
        d = ImageDraw.Draw(img)
        pos, brillo, rad = mover(emocion, home, S, f, F, fase)
        # dibujar primero los halos de todas, despues los nucleos: capas limpias
        for (x, y), b, r in zip(pos, brillo, rad):
            bb = min(1.0, b)
            d.ellipse([x - r * 2.2, y - r * 2.2, x + r * 2.2, y + r * 2.2],
                      fill=tuple(int(v * bb) for v in glow))
        for (x, y), b, r in zip(pos, brillo, rad):
            bb = min(1.0, b)
            d.ellipse([x - r, y - r, x + r, y + r], fill=tuple(min(255, int(v * bb)) for v in base))
        for (x, y, b, r) in chispas(emocion, S, f, F, rng):
            punto(d, x, y, r, b, base, glow)
        # Pocos colores: LZW comprime mucho mejor y el decoder del ESP32 trabaja menos.
        frames.append(img.quantize(colors=48, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE))

    path = os.path.join(out_dir, f"{emocion}.gif")
    frames[0].save(path, save_all=True, append_images=frames[1:], loop=0,
                   duration=ms, disposal=1, optimize=True)
    return os.path.getsize(path)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, help="carpeta destino de los 21 .gif")
    ap.add_argument("--size", type=int, default=240)
    ap.add_argument("--frames", type=int, default=16)
    ap.add_argument("--ms", type=int, default=80, help="duracion de cada frame")
    ap.add_argument("--solo", nargs="*", help="generar solo estas emociones")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    total = 0
    for e in (a.solo or EMOCIONES):
        n = generar(e, a.size, a.frames, a.ms, a.out)
        total += n
        print(f"  {e:<12} {n / 1024:7.1f} KB")
    print(f"TOTAL {total / 1024 / 1024:.2f} MB en {len(a.solo or EMOCIONES)} GIFs de {a.size}x{a.size}, {a.frames} frames")


if __name__ == "__main__":
    main()
