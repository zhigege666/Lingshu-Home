import { useState } from 'react';
import { ArrowUpRight, ChartNoAxesCombined, Clock3, GitFork, GitPullRequest, Users, Eye } from 'lucide-react';
import { getLocale, t } from '../core/i18n';
import { useHomeEnvironment } from './HomeEnvironment';

type Metric = { count: number; uniques: number };
type TrafficWindow = {
  capturedAt: string; windowBasis: 'github-last-14-days';
  windowStart: string | null; windowEnd: string | null; views: Metric; clones: Metric;
};
type TrafficData = {
  repository: { owner: string; name: string; url: string };
  baseline: TrafficWindow; current: TrafficWindow;
  daily: { date: string; views: Metric | null; clones: Metric | null; isPartial: boolean; observedAt: string | null }[];
  popularPaths: { path: string; title: string; count: number; uniques: number }[];
  referrers: { referrer: string; count: number; uniques: number }[];
  auxiliaryStatus?: { paths?: { state: string }; referrers?: { state: string } };
};
type TrafficDataset = { schemaId: string; schemaVersion: number; data: unknown; meta?: { freshness?: string; lastSuccessAt?: string | null } };
let numberLocale = '';
let numberFormatter: Intl.NumberFormat;
const number = (n: number) => {
  const locale = getLocale();
  if (numberLocale !== locale) { numberLocale = locale; numberFormatter = new Intl.NumberFormat(locale); }
  return numberFormatter.format(n);
};
const time = (value?: string | null) => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString(getLocale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : t('尚未同步', 'Not synced yet');
function trafficData(value: unknown): value is TrafficData {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<TrafficData>;
  return !!data.repository && typeof data.repository.name === 'string' && !!data.current && !!data.baseline
    && [data.current, data.baseline].every(w => [w.views?.count, w.views?.uniques, w.clones?.count, w.clones?.uniques]
      .every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) && Array.isArray(data.daily);
}

export function TrafficPanel({ dataset, title }: { dataset?: TrafficDataset; title?: string }) {
  const { preview } = useHomeEnvironment();
  const [metric, setMetric] = useState<'views' | 'clones'>('views');
  if (!dataset || dataset.schemaId !== 'github.traffic' || dataset.schemaVersion !== 1 || !trafficData(dataset.data)) {
    return <section className="lh-panel lh-traffic-panel"><div className="lh-panel-heading"><ChartNoAxesCombined size={18} /><h2>{title || 'GitHub Traffic'}</h2></div>
      <div className="lh-panel-empty"><GitPullRequest size={28} /><strong>{t('还没有采集数据', 'No traffic data yet')}</strong><p>{t('连接 GitHub 仓库后，这里会展示访问、克隆和历史基线。', 'Connect a GitHub repository to display views, clones, and its historical baseline.')}</p></div></section>;
  }
  const data = dataset.data;
  const history = data.daily.slice(-30);
  const maximum = Math.max(1, ...history.map(day => day[metric]?.count || 0));
  const stale = dataset.meta?.freshness !== 'fresh';
  const stats = [
    { label: t('访问次数', 'Views'), value: data.current.views.count, icon: Eye },
    { label: t('独立访客', 'Unique visitors'), value: data.current.views.uniques, icon: Users },
    { label: t('克隆次数', 'Clones'), value: data.current.clones.count, icon: GitFork },
    { label: t('独立克隆者', 'Unique cloners'), value: data.current.clones.uniques, icon: Users },
  ];
  const repoURL = `https://github.com/${encodeURIComponent(data.repository.owner)}/${encodeURIComponent(data.repository.name)}`;
  return <section className="lh-panel lh-traffic-panel">
    <div className="lh-panel-heading"><ChartNoAxesCombined size={18} /><h2>{title || 'GitHub Traffic'}</h2>
      <span className={`lh-freshness ${stale ? 'is-stale' : ''}`}><i />{stale ? t('已保存快照', 'Saved snapshot') : t('已同步', 'Synced')}</span></div>
    <div className="lh-traffic-repo"><a href={preview ? undefined : repoURL} role={preview ? 'link' : undefined} aria-disabled={preview || undefined} tabIndex={preview ? 0 : undefined} target={preview ? undefined : '_blank'} rel={preview ? undefined : 'noopener noreferrer'}>{data.repository.owner} / {data.repository.name}<ArrowUpRight size={14} /></a><span>{t('GitHub 最近 14 天', 'GitHub · Last 14 days')}</span></div>
    <div className="lh-traffic-stats">{stats.map(stat => <div key={stat.label}><span><stat.icon size={14} />{stat.label}</span><strong>{number(stat.value)}</strong></div>)}</div>
    <div className="lh-traffic-chart-header"><strong>{t('每日趋势', 'Daily trend')}</strong><div className="lh-segmented" aria-label={t('趋势指标', 'Trend metric')}>{(['views', 'clones'] as const).map(key => <button key={key} aria-pressed={metric === key} onClick={() => setMetric(key)}>{key === 'views' ? t('访问', 'Views') : t('克隆', 'Clones')}</button>)}</div></div>
    {history.length ? <div className="lh-traffic-chart"><svg viewBox={`0 0 ${Math.max(history.length * 20, 100)} 100`} preserveAspectRatio="none" role="img" aria-label={metric === 'views' ? t('最近 {count} 个 UTC 日期的访问次数，下方可展开每日明细', 'Views for the last {count} UTC dates. Expand daily details below.', { count: history.length }) : t('最近 {count} 个 UTC 日期的克隆次数，下方可展开每日明细', 'Clones for the last {count} UTC dates. Expand daily details below.', { count: history.length })}>
      <line x1="0" y1="96" x2={Math.max(history.length * 20, 100)} y2="96" />
      {history.map((day, index) => {
        const observed = day[metric] != null;
        const height = observed ? Math.max(2, (day[metric]!.count / maximum) * 82) : 0;
        return <g key={day.date}><title>{`${day.date}: ${observed ? number(day[metric]!.count) : t('未采集', 'Not collected')}${day.isPartial ? t('（部分日期数据）', ' (partial day)') : ''}`}</title>
          {observed ? <rect x={index * 20 + 3} y={96 - height} width="13" height={height} rx="3" className={day.isPartial ? 'is-partial' : ''} /> : <circle cx={index * 20 + 9} cy="94" r="2" className="is-missing" />}</g>;
      })}</svg><div className="lh-chart-dates"><span>{history[0].date}</span><span>UTC · {history[history.length - 1].date}</span></div></div>
      : <p className="lh-muted">{t('还没有日级历史记录。', 'No daily history yet.')}</p>}
    <div className="lh-traffic-updated"><Clock3 size={13} /><span>{t('最近成功同步 {time}', 'Last successful sync {time}', { time: time(dataset.meta?.lastSuccessAt || data.current.capturedAt) })}</span></div>
    <details className="lh-traffic-details"><summary>{t('首次基线与每日明细', 'First baseline and daily details')}</summary>
      <p>{t('首次完整采集：{time}。此基线保留当时 GitHub 最近 14 天的统计，不随后续同步覆盖。', 'First complete capture: {time}. This baseline preserves GitHub’s last 14 days at that time and is not overwritten by later syncs.', { time: time(data.baseline.capturedAt) })}</p>
      <dl className="lh-baseline"><div><dt>{t('访问 / 独立访客', 'Views / unique visitors')}</dt><dd>{number(data.baseline.views.count)} / {number(data.baseline.views.uniques)}</dd></div><div><dt>{t('克隆 / 独立克隆者', 'Clones / unique cloners')}</dt><dd>{number(data.baseline.clones.count)} / {number(data.baseline.clones.uniques)}</dd></div></dl>
      <div className="lh-table-scroll"><table><caption>{t('已保存的 UTC 日级流量；— 表示缺失，* 表示尚不完整。', 'Saved daily UTC traffic. — means missing; * means incomplete.')}</caption><thead><tr><th>{t('UTC 日期', 'UTC date')}</th><th>{t('访问', 'Views')}</th><th>{t('独立访客', 'Unique visitors')}</th><th>{t('克隆', 'Clones')}</th><th>{t('独立克隆者', 'Unique cloners')}</th></tr></thead><tbody>{data.daily.slice(-90).reverse().map(day => <tr key={day.date}><th>{day.date}{day.isPartial ? ' *' : ''}</th><td>{day.views ? number(day.views.count) : '—'}</td><td>{day.views ? number(day.views.uniques) : '—'}</td><td>{day.clones ? number(day.clones.count) : '—'}</td><td>{day.clones ? number(day.clones.uniques) : '—'}</td></tr>)}</tbody></table></div>
      <p>{t('独立访客和独立克隆者的 14 天总数使用 GitHub 返回值，不能用每日独立人数相加。API 未提供窗口的精确起止时间。', 'The 14-day unique visitor and cloner totals come from GitHub; daily unique counts cannot be added together. The API does not expose exact window boundaries.')}</p>
      {!!data.referrers?.length && <div className="lh-traffic-ranking"><h3>{t('来源', 'Referrers')}</h3>{data.referrers.map(item => <div key={item.referrer}><span>{item.referrer}</span><strong>{number(item.count)}</strong></div>)}</div>}
      {!!data.popularPaths?.length && <div className="lh-traffic-ranking"><h3>{t('热门路径', 'Popular paths')}</h3>{data.popularPaths.map(item => <div key={item.path}><span title={item.path}>{item.title || item.path}</span><strong>{number(item.count)}</strong></div>)}</div>}
      {(data.auxiliaryStatus?.paths?.state !== 'ok' || data.auxiliaryStatus?.referrers?.state !== 'ok') && <p className="lh-muted">{t('来源与热门路径有各自的同步状态，失败时可能显示上次成功的数据。', 'Referrers and popular paths sync independently. After a failure they may show the last successful data.')}</p>}
    </details>
  </section>;
}
