// ============ 下载器视图（F-201~209 + P-01/P-02）============
import { useMemo, useState } from 'react';
import type { MediaItem, Variant, DownloadTask } from '../shared/types';
import { MSG, send } from '../shared/messages';
import { formatBytes, formatDuration, resolutionOf } from '../shared/format';
import { useToast } from './store';
import {
  VideoThumbIcon, AudioThumbIcon, KebabIcon, ChevronDown, SearchIcon, DownloadIcon, BoltIcon,
  ConvertIcon, CopyIcon, PreviewIcon, BanIcon, LockIcon, SearchOffIcon,
} from './icons';

interface Props {
  state: { items: MediaItem[]; filteredCount: number; protectedCount: number; parsingCount: number; tabUrl?: string; pageTitle?: string };
  tasks: DownloadTask[];
  settings: { quickDownload: boolean };
  onOpenSettings: (anchor?: string) => void;
  onOpenLog: () => void;
}

type TypeFilter = 'all' | 'video' | 'audio';

export function MediaListView({ state, tasks, settings, onOpenSettings, onOpenLog }: Props) {
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedVariant, setSelectedVariant] = useState<Record<string, string>>({});
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [drmFor, setDrmFor] = useState<MediaItem | null>(null);
  const [engineGuide, setEngineGuide] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [toast, showToast] = useToast();

  const items = state.items;

  const filtered = useMemo(() => {
    let out = items;
    if (typeFilter !== 'all') out = out.filter((i) => i.type === typeFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      out = out.filter((i) => {
        if (i.title.toLowerCase().includes(q)) return true;
        if (i.durationSec != null && formatDuration(i.durationSec).includes(q)) return true;
        if (i.sizeEstimate != null && formatBytes(i.sizeEstimate).toLowerCase().includes(q)) return true;
        return false;
      });
    }
    return out;
  }, [items, typeFilter, search]);

  const downloadable = filtered.filter((i) => i.downloadable);

  const doDownload = async (item: MediaItem, variantId?: string, convert = false) => {
    if (!item.downloadable) {
      if (item.blockedReason === 'drm' || item.blockedReason === 'sampleaes') setDrmFor(item);
      else if (item.blockedReason === 'live') showToast('直播流暂不支持下载', 'err');
      else if (item.blockedReason === 'blob') showToast('该媒体为页面内存流，无独立地址', 'err');
      return;
    }
    const r = await send<{ ok: boolean; error?: string; existingTaskId?: string }>(MSG.CREATE_TASK, {
      mediaId: item.id,
      tabId: item.tabId,
      variantId: variantId ?? selectedVariant[item.id] ?? item.variants[0]?.id,
      convert,
    });
    if (r.ok) showToast(`已加入下载队列：${item.title}`);
    else if (r.existingTaskId) showToast(r.error ?? '该视频已在下载队列中', 'err');
    else showToast(r.error ?? '创建任务失败', 'err');
  };

  /** 不可下载原因分流：只有真 DRM 才弹版权提示，内存流/直播给针对性说明 */
  const explainUnavailable = (item: MediaItem) => {
    switch (item.blockedReason) {
      case 'drm':
      case 'sampleaes':
        setDrmFor(item);
        break;
      case 'live':
        showToast('直播流暂不支持下载', 'err');
        break;
      case 'blob':
        showToast('这是页面内存流（MSE）引用，真正地址在网络层——播放几秒后再看列表', 'err');
        break;
      default:
        showToast(item.status === 'parse_failed' ? '清单解析失败，请刷新页面重试' : '该媒体暂不可下载', 'err');
    }
  };

  const copyUrl = async (item: MediaItem) => {
    if (item.blockedReason === 'blob') {
      showToast('该媒体为页面内存流，无独立地址', 'err');
      return;
    }
    await navigator.clipboard.writeText(item.masterUrl);
    showToast('地址已复制');
  };

  const addToBlacklist = async (item: MediaItem) => {
    await send(MSG.ADD_BLACKLIST, { domain: item.siteDomain });
    showToast(`已加入黑名单：${item.siteDomain}（已打开页面需刷新生效）`, 'err');
  };

  // 空态成因判定优先级：DRM ＞ 被过滤 ＞ 无媒体（F-209）
  const renderEmpty = () => {
    if (state.protectedCount > 0 && items.length === state.protectedCount) {
      return (
        <div className="empty">
          <div className="illus"><LockIcon size={28} /></div>
          <h4>检测到的媒体受版权保护</h4>
          <p>该内容受数字版权保护（DRM），平台限制下载，本扩展不提供绕过</p>
          <div className="acts">
            <button className="btn line" onClick={() => setDrmFor(items[0] ?? null)}>了解详情</button>
          </div>
        </div>
      );
    }
    if (state.filteredCount > 0) {
      return (
        <div className="empty">
          <div className="illus"><SearchOffIcon /></div>
          <h4>有 {state.filteredCount} 个媒体被过滤规则隐藏</h4>
          <p>当前嗅探过滤（类型/体积/扩展名）命中了部分媒体</p>
          <div className="acts">
            <button className="btn line" onClick={() => onOpenSettings('sniffer')}>查看过滤规则</button>
          </div>
        </div>
      );
    }
    return (
      <div className="empty">
        <div className="illus"><SearchOffIcon /></div>
        <h4>当前页面未检测到可下载媒体</h4>
        <p>播放页面中的视频试试——部分站点需开始播放后才会动态拉流</p>
        <div className="acts">
          <button className="btn" onClick={() => {
            void send(MSG.RESCAN_TAB);
            showToast('已重新扫描当前页面');
          }}>重新扫描</button>
          <button className="btn line" onClick={() => onOpenLog()}>查看运行日志</button>
          <button className="btn line" onClick={() => onOpenSettings('sniffer')}>查看过滤规则</button>
        </div>
      </div>
    );
  };

  return (
    <div className="view">
      <div className="toolbar">
        <div className="stat">当前页面检测到 <b>{items.length}</b> 个媒体</div>
        <div className="seg">
          {(['all', 'video', 'audio'] as const).map((t) => (
            <button key={t} className={`opt ${typeFilter === t ? 'on' : ''}`} onClick={() => setTypeFilter(t)}>
              {t === 'all' ? '全部' : t === 'video' ? '视频' : '音频'}
            </button>
          ))}
        </div>
        <button className="icon-btn" onClick={() => { setSearchOpen(!searchOpen); if (searchOpen) setSearch(''); }} aria-label="搜索">
          <SearchIcon size={14} />
        </button>
      </div>

      {searchOpen && (
        <div className="search">
          <SearchIcon />
          <input autoFocus placeholder="搜索标题 / 时长 10:30 / 体积 150MB" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      )}

      {filtered.length === 0 && items.length === 0 ? (
        renderEmpty()
      ) : filtered.length === 0 ? (
        <div className="empty">
          <div className="illus"><SearchOffIcon /></div>
          <h4>没有匹配的媒体</h4>
          <p>试试调整筛选条件或搜索词</p>
        </div>
      ) : (
        <div className="mlist">
          {filtered.map((item) => (
            <MediaRow
              key={item.id}
              item={item}
              expanded={expanded.has(item.id)}
              onToggleExpand={() =>
                setExpanded((prev) => {
                  const next = new Set(prev);
                  if (next.has(item.id)) next.delete(item.id);
                  else next.add(item.id);
                  return next;
                })
              }
              selectedVariantId={selectedVariant[item.id] ?? item.variants[0]?.id}
              onSelectVariant={(vid) => setSelectedVariant((prev) => ({ ...prev, [item.id]: vid }))}
              checked={checked.has(item.id)}
              onCheck={() =>
                setChecked((prev) => {
                  const next = new Set(prev);
                  if (next.has(item.id)) next.delete(item.id);
                  else next.add(item.id);
                  return next;
                })
              }
              menuOpen={menuFor === item.id}
              onMenu={() => setMenuFor(menuFor === item.id ? null : item.id)}
              onDownload={() => void doDownload(item)}
              onQuickDownload={() => void doDownload(item)}
              onConvert={() => {
                if (!item.downloadable) return void doDownload(item);
                setEngineGuide(true);
              }}
              onCopy={() => void copyUrl(item)}
              onPreview={() => {
                if (item.blockedReason === 'blob') return void showToast('该媒体为页面内存流，无法预览', 'err');
                void chrome.tabs.create({ url: item.masterUrl });
              }}
              onBlacklist={() => void addToBlacklist(item)}
              onDrmInfo={() => setDrmFor(item)}
              onUnavailable={() => explainUnavailable(item)}
            />
          ))}
        </div>
      )}

      {/* 批量条 */}
      {filtered.length > 0 && (
        <div className="batch">
          <button
            className={`cbx ${checked.size === downloadable.length && downloadable.length > 0 ? 'on' : ''}`}
            onClick={() => setChecked(checked.size === downloadable.length ? new Set() : new Set(downloadable.map((i) => i.id)))}
            aria-label="全选可下载项"
          />
          <div className="cnt">全选可下载项 · 已选 <b>{checked.size}</b> 项</div>
          <button
            className="btn"
            disabled={checked.size === 0}
            onClick={() => {
              void (async () => {
                let idx = 0;
                for (const item of filtered) {
                  if (!checked.has(item.id) || !item.downloadable) continue;
                  idx++;
                  await send(MSG.CREATE_TASK, { mediaId: item.id, tabId: item.tabId, index: idx });
                }
                showToast(`已加入 ${idx} 个下载任务`);
                setChecked(new Set());
              })();
            }}
          >
            批量下载
          </button>
        </div>
      )}

      {/* DRM 说明浮层（E-018） */}
      {drmFor && (
        <div className="dlg warn">
          <h5><LockIcon /> 该内容受数字版权保护（DRM）</h5>
          <p>平台限制下载，本扩展不提供绕过。<br />这是内容方的保护机制，不是扩展故障。</p>
          <div className="acts"><button className="btn line" onClick={() => setDrmFor(null)}>知道了</button></div>
        </div>
      )}

      {/* 引擎引导浮层（E-014 / IX-06） */}
      {engineGuide && (
        <div className="dlg info">
          <h5>需要本地处理引擎</h5>
          <p>「下载并转换」需要本机安装处理引擎才能完成转码。<b>仅需合并视频则无需安装</b>，可直接下载。</p>
          <div className="acts">
            <button className="btn line" onClick={() => setEngineGuide(false)}>稍后</button>
            <button className="btn" onClick={() => { setEngineGuide(false); onOpenSettings('engine'); }}>查看安装指引</button>
          </div>
        </div>
      )}

      {toast && (
        <div className={`toast ${toast.kind === 'err' ? 'err' : ''}`}>
          {toast.text}
          {toast.action && <button onClick={toast.action.fn}>{toast.action.label}</button>}
        </div>
      )}
      {tasks.length > 0 && settings.quickDownload === undefined && null}
    </div>
  );
}

// ---------- 单条媒体行 ----------
interface RowProps {
  item: MediaItem;
  expanded: boolean;
  onToggleExpand: () => void;
  selectedVariantId?: string;
  onSelectVariant: (id: string) => void;
  checked: boolean;
  onCheck: () => void;
  menuOpen: boolean;
  onMenu: () => void;
  onDownload: () => void;
  onQuickDownload: () => void;
  onConvert: () => void;
  onCopy: () => void;
  onPreview: () => void;
  onBlacklist: () => void;
  onDrmInfo: () => void;
  onUnavailable: () => void;
}

function MediaRow(p: RowProps) {
  const { item } = p;
  const res = resolutionOf(item.resolution ?? item.variants[0]?.resolution);
  const dur = item.durationSec != null ? formatDuration(item.durationSec) : null;
  const hasVariants = item.variants.length > 1;

  const badges: React.ReactNode[] = [];
  if (res.label) badges.push(<span key="res" className="tag res">{res.label}{hasVariants ? ` · ${item.variants.length} 变体` : ''}</span>);
  if (item.protocol === 'dash' && item.tracks.length > 1) badges.push(<span key="dash" className="tag dash">DASH 双轨</span>);
  if (item.protocol === 'dash' && item.tracks.length === 1) badges.push(<span key="novo" className="tag enc">仅视频轨（无声音）</span>);
  if (item.encryption === 'aes128') badges.push(<span key="enc" className="tag enc">AES-128</span>);
  if (item.blockedReason === 'drm') badges.push(<span key="drm" className="tag drm">🔒 受保护</span>);
  if (item.blockedReason === 'sampleaes') badges.push(<span key="sa" className="tag drm">🔒 SAMPLE-AES</span>);
  if (item.blockedReason === 'live') badges.push(<span key="live" className="tag res">直播 · 本期不支持</span>);
  if (item.blockedReason === 'blob') badges.push(<span key="blob" className="tag res">内存流</span>);
  if (item.status === 'parse_failed') badges.push(<span key="err" className="tag err">解析失败</span>);
  if (item.status === 'parsing') badges.push(<span key="parsing" className="tag res">解析中</span>);

  return (
    <div className={`mitem ${p.expanded ? 'wrap' : ''}`}>
      <div className={`thumb ${item.type === 'audio' ? 'audio' : ''}`}>
        {item.type === 'audio' ? <AudioThumbIcon /> : <VideoThumbIcon />}
        {dur && <span className="dur">{dur}</span>}
      </div>
      <div className="minfo">
        <div className="mtitle">
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.title}</span>
          {hasVariants && (
            <span className="exp" onClick={p.onToggleExpand}>
              {p.expanded ? '收起' : '展开'} <ChevronDown />
            </span>
          )}
        </div>
        <div className="mspec">
          {[
            item.resolution ?? item.variants[0]?.resolution,
            item.sizeEstimate != null ? formatBytes(item.sizeEstimate) : null,
            (item.masterUrl.split('?')[0]?.split('.').pop() ?? '').toUpperCase() || null,
          ].filter(Boolean).join(' · ') || '规格未知'}
        </div>
        <div className="mbadges">{badges}</div>
      </div>
      <div className="mops">
        <button className={`kebab ${p.menuOpen ? 'on' : ''}`} onClick={p.onMenu} aria-label="操作菜单">
          <KebabIcon />
        </button>
        {p.checked && null}
      </div>

      {/* 操作菜单（F-207 / P-02） */}
      {p.menuOpen && (
        <div className="menu-anchor">
          <div className="overlay" onClick={p.onMenu} />
          <div className="menu">
            <button
              className={`mi ${!item.downloadable ? 'off' : ''}`}
              onClick={() => { p.onMenu(); if (item.downloadable) p.onDownload(); else p.onUnavailable(); }}
            >
              <DownloadIcon />下载<span className="hint">{item.blockedReason === 'drm' ? 'DRM' : item.blockedReason === 'blob' ? '内存流' : ''}</span>
            </button>
            <button
              className={`mi ${!item.downloadable ? 'off' : ''}`}
              onClick={() => { p.onMenu(); item.downloadable && p.onQuickDownload(); }}
            >
              <BoltIcon />快速下载
            </button>
            <button
              className={`mi ${!item.downloadable ? 'off' : ''}`}
              onClick={() => { p.onMenu(); p.onConvert(); }}
            >
              <ConvertIcon />下载并转换<span className="hint">需引擎</span>
            </button>
            <div className="msep" />
            <button className="mi" onClick={() => { p.onMenu(); p.onCopy(); }}>
              <CopyIcon />复制地址
            </button>
            <button className="mi" onClick={() => { p.onMenu(); p.onPreview(); }}>
              <PreviewIcon />在新标签页预览
            </button>
            <button className="mi danger" onClick={() => { p.onMenu(); p.onBlacklist(); }}>
              <BanIcon />加入域名黑名单
            </button>
          </div>
        </div>
      )}

      {/* 变体展开（F-202） */}
      {p.expanded && hasVariants && (
        <div className="variants">
          {item.variants.map((v: Variant) => {
            const sel = v.id === p.selectedVariantId;
            return (
              <button key={v.id} className={`vrow ${sel ? 'sel' : ''}`} onClick={() => p.onSelectVariant(v.id)}>
                <span className="radio" />
                <span className="vspec">
                  {[
                    v.resolution ?? '未知分辨率',
                    v.bandwidth ? `${Math.round(v.bandwidth / 1000)}kbps` : null,
                    v.durationSec != null ? formatDuration(v.durationSec) : null,
                  ].filter(Boolean).join(' · ')}
                </span>
                {v.recommended && <span className="rec">推荐</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
