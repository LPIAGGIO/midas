# -*- coding: utf-8 -*-
# Cuentas y configuración: una tarjeta por CUENTA, no por broker (LP 12/10/2026:
# "aparece 1 sola" con la 3893 dada de alta). El conteo de operaciones también
# va por cuenta y se lee paginado (Supabase corta en 1.000).
import io, sys
p = r'C:\Users\slider\Documents\Claude\Projects\Midas\src\MidasTerminal.jsx'
s = io.open(p, encoding='utf-8').read()
def sub(a, b, et, n=1):
    global s
    k = s.count(a)
    if k != n:
        print('%s: ancla %d veces (esperaba %d), no escribo nada' % (et, k, n)); sys.exit(1)
    s = s.replace(a, b)

sub('''function usePositionsBrokerStats(userId) {
  const [data, setData] = useState({});
  const [loading, setLoading] = useState(true);
''', '''function usePositionsBrokerStats(userId) {
  const [data, setData] = useState({});
  const [porCuenta, setPorCuenta] = useState({});   // "broker|cuenta" -> cantidad
  const [loading, setLoading] = useState(true);
''', 'stats estado')
sub('''    let cancelled = false;
    supabase
      .from("positions")
      .select("broker")
      .eq("user_id", userId)
      .then(({ data: rows, error: err }) => {
        if (cancelled) return;
        if (!err && rows) {
          const counts = {};
          rows.forEach((r) => {
            const b = r.broker || "manual";
            counts[b] = (counts[b] || 0) + 1;
          });
          setData(counts);
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return { data, loading };''',
'''    let cancelled = false;
    (async () => {
      const rows = []; let err = null;
      for (let desde = 0; ; desde += 1000) {
        const r = await supabase.from("positions").select("broker,cuenta").eq("user_id", userId).order("id", { ascending: true }).range(desde, desde + 999);
        if (r.error) { err = r.error; break; }
        rows.push(...(r.data || []));
        if (!r.data || r.data.length < 1000) break;
      }
      if (cancelled) return;
      if (!err) {
        const counts = {}, pc = {};
        rows.forEach((r) => {
          const b = r.broker || "manual";
          counts[b] = (counts[b] || 0) + 1;
          const k = `${b}|${r.cuenta || "principal"}`;
          pc[k] = (pc[k] || 0) + 1;
        });
        setData(counts); setPorCuenta(pc);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return { data, porCuenta, loading };''', 'stats fetch')

sub('''  const { data: stats } = usePositionsBrokerStats(userId);''',
'''  const { data: stats, porCuenta: statsCuenta } = usePositionsBrokerStats(userId);''', 'stats consumer')
sub('''          stats={stats}''', '''          stats={stats}
          statsCuenta={statsCuenta}''', 'stats prop')

sub('''        "id, broker, label, status, status_message, vault_secret_name, bot_enabled, bot_extra_calls_allowed, last_sync_at, last_sync_status, created_at, updated_at"''',
'''        "id, broker, cuenta, broker_account_id, label, status, status_message, vault_secret_name, bot_enabled, bot_extra_calls_allowed, last_sync_at, last_sync_status, created_at, updated_at"''', 'linked select')

sub('''function BrokersTab({ brokers, loading, stats, userId, refetchBrokers, cashSnapshots }) {''',
'''function BrokersTab({ brokers, loading, stats, statsCuenta = {}, userId, refetchBrokers, cashSnapshots }) {''', 'tab firma')
sub('''  const items = Array.from(allBrokerIds).map((bid) => {
    const linked = brokers.find((b) => b.broker === bid);
    const meta = BROKER_CATALOG[bid] || BROKER_CATALOG.manual;
    const positionCount = stats[bid] || 0;
    return { id: bid, meta, linked, positionCount };
  });''',
'''  // Una tarjeta por cuenta (varias cuentas del mismo broker, 12/10/2026). Los
  // brokers con posiciones pero sin fila en linked_brokers siguen apareciendo
  // como "detectados", en una sola tarjeta.
  const items = [];
  for (const bid of allBrokerIds) {
    const meta = BROKER_CATALOG[bid] || BROKER_CATALOG.manual;
    const filas = brokers.filter((b) => b.broker === bid);
    if (!filas.length) { items.push({ k: bid, id: bid, meta, linked: undefined, positionCount: stats[bid] || 0 }); continue; }
    for (const linked of filas) {
      const cta = linked.cuenta || "principal";
      const n = statsCuenta[`${bid}|${cta}`];
      items.push({ k: `${bid}:${cta}`, id: bid, meta, linked, positionCount: n != null ? n : (filas.length === 1 ? (stats[bid] || 0) : 0) });
    }
  }''', 'items por cuenta')
sub('''          <BrokerCard key={item.id} {...item} userId={userId} refetchBrokers={refetchBrokers} cashSnapshots={cashSnapshots} />''',
'''          <BrokerCard key={item.k} {...item} userId={userId} refetchBrokers={refetchBrokers} cashSnapshots={cashSnapshots} />''', 'card key')
sub('''              {linked && linked.label ? linked.label : meta.label}''',
'''              {linked && linked.label ? linked.label : meta.label}{linked?.broker_account_id && !String(linked.label || "").includes(String(linked.broker_account_id)) ? ` · ${linked.broker_account_id}` : ""}''', 'card label')
io.open(p, 'w', encoding='utf-8').write(s); print('ok')
