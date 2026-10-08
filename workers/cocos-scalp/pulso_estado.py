# -*- coding: utf-8 -*-
# Pulso de los 20 scalps leyendo la última línea "estado" de cada bot (libro
# propio del bot), para cuando data912 no da precio y pulso.js muestra "px ?".
# Resultado del día = realizado + latente − latente al cierre anterior.
#   python pulso_estado.py -560997 -462723     (latente al cierre anterior 72404 y 3893)
import re, subprocess, sys
prev = {'72404': int(sys.argv[1]) if len(sys.argv) > 1 else 0, '3893': int(sys.argv[2]) if len(sys.argv) > 2 else 0}
CMD = ('date +%H:%M:%S; for n in $(pm2 jlist 2>/dev/null | node -e "let s=\\"\\";process.stdin.on(\\"data\\",d=>s+=d).on(\\"end\\",()=>console.log('
       'JSON.parse(s).filter(p=>/^cocos2?-scalp/.test(p.name)&&p.pm2_env.status===\\"online\\").map(p=>p.name).join(\\" \\")))"); '
       'do echo "$n | $(pm2 logs $n --nostream --lines 400 2>&1 | grep "estado · tengo" | tail -n 1 | cut -c1-260)"; done; '
       'echo "CAUCION | $(pm2 logs caucion-tomadora --nostream --lines 6 2>&1 | grep -v "^$" | tail -n 2 | cut -c60-300 | tr "\\n" " ")"')
out = subprocess.run(['ssh', '-p', '5008', '-i', '~/.ssh/id_ed25519'.replace('~', __import__('os').path.expanduser('~')), 'midas@149.50.148.172', CMD],
                     capture_output=True, text=True, encoding='utf-8').stdout.splitlines()
print('hora del dato', out[0])
tot = {}
for l in out[1:]:
    n, _, r = l.partition(' | ')
    if n == 'CAUCION':
        print('caución:', r.strip()); continue
    cta = '3893' if n.startswith('cocos2') else '72404'
    m = re.search(r'T(\d\d:\d\d):\d\d: .*\[scalp (\w+)\].*tengo (\d+).*libro \$([\d.]+)/\$([\d.]+).*abierto (-?)\$([\d.]+).*P&L del día (-?)\$([\d.]+) · (\d+) ventas', r)
    if not m:
        print('??', n, r[:160]); continue
    hh, tk, q, bid, ask, sg, ab, sp, pnl, v = m.groups()
    ab = int(ab.replace('.', '')) * (-1 if sg else 1); pnl = int(pnl.replace('.', '')) * (-1 if sp else 1)
    t = tot.setdefault(cta, [0, 0, 0]); t[0] += pnl; t[1] += ab; t[2] += int(v)
    print('%-5s %-5s %s tengo %5s · punta %8s · latente %+9d · realizado %+7d · %s ventas' % (cta, tk, hh, q, bid, ab, pnl, v))
for c, (r, a, v) in tot.items():
    print('CUENTA %s · realizado %+d · latente %+d · ventas %d · RESULTADO DEL DÍA %+d' % (c, r, a, v, r + a - prev[c]))
