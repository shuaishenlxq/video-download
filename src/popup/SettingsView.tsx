// ============ 设置页（F-501~505/507 + P-03）============
import { useState, useRef, useEffect } from 'react';
import type { Settings } from '../shared/types';
import { MSG, send } from '../shared/messages';
import { previewFilename, validateTemplate, TEMPLATE_VARS } from '../shared/naming';
import { InfoIcon, ShieldIcon, ListIcon, ResetIcon } from './icons';
import { useToast, useConfirm } from './store';

interface Props {
  settings: Settings;
  update: (patch: Partial<Settings>) => Promise<void>;
  onOpenLog: () => void;
  onOpenAbout: () => void;
  onOpenEngine: () => void;
  anchor?: string | null;
}

export function SettingsView({ settings, update, onOpenLog, onOpenAbout, onOpenEngine, anchor }: Props) {
  const [, showToast] = useToast();
  const [confirmState, openConfirm, closeConfirm] = useConfirm();
  const [newDomain, setNewDomain] = useState('');
  const [tplError, setTplError] = useState<string | null>(null);
  const snifferRef = useRef<HTMLDivElement | null>(null);
  // 系统外观实时状态（用于「跟随系统」时展示当前生效的是深色还是浅色）
  const [systemDark, setSystemDark] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent): void => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // 锚点滚动（空态「查看过滤规则」→ 嗅探分区）
  useEffect(() => {
    if (anchor === 'sniffer') {
      setTimeout(() => snifferRef.current?.scrollIntoView({ behavior: 'smooth' }), 80);
    }
  }, [anchor]);

  const setTemplate = (tpl: string) => {
    const v = validateTemplate(tpl);
    setTplError(v.ok ? null : (v.reason ?? '模板不合法'));
    if (v.ok) void update({ namingTemplate: tpl });
  };

  const addDomain = () => {
    const d = newDomain.trim().toLowerCase();
    if (!d || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) {
      showToast('域名格式不合法', 'err');
      return;
    }
    const list = settings.domainFilterMode === 'whitelist' ? [...new Set([...settings.whitelist, d])] : [...new Set([...settings.blacklist, d])];
    void update(settings.domainFilterMode === 'whitelist' ? { whitelist: list } : { blacklist: list });
    setNewDomain('');
    showToast('已添加（已打开页面需刷新后生效）');
  };

  const removeDomain = (d: string) => {
    openConfirm({
      message: `移除域名 ${d}？`,
      onConfirm: () => {
        void update({
          blacklist: settings.blacklist.filter((x) => x !== d),
          whitelist: settings.whitelist.filter((x) => x !== d),
        });
        closeConfirm();
      },
    });
  };

  const domains = settings.domainFilterMode === 'whitelist' ? settings.whitelist : settings.blacklist;

  return (
    <div className="view">
      <div className="set-body">
        {/* 合规卡（F-506 已确认态） */}
        <div className="compliance">
          <h5><ShieldIcon />使用须知与合规</h5>
          <div className="line">
            <span className="cbx on" />
            我已阅读并同意仅下载我有合法使用权的内容
            <a onClick={onOpenAbout}>查看完整声明</a>
          </div>
        </div>

        {/* 嗅探设置（F-502） */}
        <div ref={snifferRef} className="group-title">嗅探设置<span className="ln" /></div>
        <div className="group-card">
          <div className="srow">
            <div className="lb">媒体类型</div>
            <div className="ct">
              <div className="seg" style={{ alignSelf: 'flex-start' }}>
                {([['all', '全部'], ['video', '仅视频'], ['audio', '仅音频']] as const).map(([v, label]) => (
                  <button key={v} className={`opt ${settings.sniffType === v ? 'on' : ''}`} onClick={() => void update({ sniffType: v })}>{label}</button>
                ))}
              </div>
            </div>
          </div>
          <div className="srow">
            <div className="lb">体积范围</div>
            <div className="ct">
              <div className="range">
                <input className="inp short" defaultValue={settings.sniffMinSizeMb ?? 0} onBlur={(e) => void update({ sniffMinSizeMb: Number(e.target.value) || null })} /> MB
                ~ <input className="inp short" style={{ width: 70 }} placeholder="不限" defaultValue={settings.sniffMaxSizeMb ?? ''} onBlur={(e) => void update({ sniffMaxSizeMb: Number(e.target.value) || null })} /> MB
              </div>
            </div>
          </div>
          <div className="srow">
            <div className="lb">扩展名</div>
            <div className="ct">
              <div className="chips">
                {settings.sniffExtensions.map((ext) => (
                  <button
                    key={ext}
                    className="chip"
                    onClick={() => openConfirm({
                      message: `移除扩展名 ${ext}？该类型媒体将不再被检测`,
                      onConfirm: () => { void update({ sniffExtensions: settings.sniffExtensions.filter((x) => x !== ext) }); closeConfirm(); },
                    })}
                  >
                    {ext}
                  </button>
                ))}
                <button className="chip add" onClick={() => {
                  const ext = prompt('输入扩展名（不带点）');
                  if (ext && /^[a-z0-9]{1,6}$/i.test(ext)) void update({ sniffExtensions: [...new Set([...settings.sniffExtensions, ext.toLowerCase()])] });
                }}>＋ 添加</button>
              </div>
            </div>
          </div>
          <div className="srow">
            <div className="lb">域名过滤</div>
            <div className="ct">
              <div className="seg" style={{ alignSelf: 'flex-start' }}>
                {([['blacklist', '黑名单'], ['whitelist', '白名单'], ['all', '全部嗅探']] as const).map(([v, label]) => (
                  <button key={v} className={`opt ${settings.domainFilterMode === v ? 'on' : ''}`} onClick={() => void update({ domainFilterMode: v })}>{label}</button>
                ))}
              </div>
              {settings.domainFilterMode !== 'all' && (
                <>
                  {domains.length === 0 ? (
                    <div className="note"><InfoIcon />{settings.domainFilterMode === 'blacklist' ? '黑名单为空，当前会嗅探所有网站' : '白名单为空，当前不会嗅探任何网站'}</div>
                  ) : (
                    <div className="domlist">
                      {domains.map((d) => (
                        <div className="domrow" key={d}>
                          {d}
                          <button className="x" onClick={() => removeDomain(d)} aria-label={`删除 ${d}`}>
                            <svg width="9" height="9" viewBox="0 0 10 10" fill="none"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="chips">
                    <input
                      className="inp"
                      style={{ width: 160 }}
                      placeholder="输入域名如 example.com"
                      value={newDomain}
                      onChange={(e) => setNewDomain(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && addDomain()}
                    />
                    <button className="chip add" onClick={addDomain}>＋ 添加域名</button>
                    <button className="chip" onClick={() => {
                      const text = prompt('粘贴域名列表（每行一个）');
                      if (text) {
                        const lines = text.split(/\n+/).map((s) => s.trim().toLowerCase()).filter((s) => /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(s));
                        const list = [...new Set([...domains, ...lines])];
                        void update(settings.domainFilterMode === 'whitelist' ? { whitelist: list } : { blacklist: list });
                        showToast(`已导入 ${lines.length} 个域名（非法行已跳过）`);
                      }
                    }}>批量导入</button>
                    <button className="chip" onClick={() => {
                      void navigator.clipboard.writeText(domains.join('\n'));
                      showToast('已复制到剪贴板');
                    }}>导出</button>
                  </div>
                </>
              )}
              <div className="note"><InfoIcon />已打开页面需刷新后完全生效 · 区别于列表筛选：此处命中的媒体根本不会被检测</div>
            </div>
          </div>
        </div>

        {/* 下载设置（F-503） */}
        <div className="group-title">下载设置<span className="ln" /></div>
        <div className="group-card">
          <div className="srow">
            <div className="lb">并发</div>
            <div className="ct">
              <div className="range">
                同时任务 <input className="inp short" style={{ width: 52 }} defaultValue={settings.maxConcurrentTasks} onBlur={(e) => void update({ maxConcurrentTasks: Math.min(5, Math.max(1, Number(e.target.value) || 2)) })} />
                × 单任务分片 <input className="inp short" style={{ width: 52 }} defaultValue={settings.segmentConcurrency} onBlur={(e) => void update({ segmentConcurrency: Math.min(8, Math.max(1, Number(e.target.value) || 4)) })} />
              </div>
              <div className="note"><InfoIcon />峰值并发 {settings.maxConcurrentTasks * settings.segmentConcurrency} 个请求。修改仅对新任务生效</div>
            </div>
          </div>
          <div className="srow">
            <div className="lb">命名模板</div>
            <div className="ct">
              <input className="inp" defaultValue={settings.namingTemplate} onBlur={(e) => setTemplate(e.target.value)} style={tplError ? { borderColor: 'var(--danger)' } : undefined} />
              {tplError && <div className="note" style={{ color: 'var(--danger)' }}><InfoIcon />{tplError}</div>}
              <div className="chips">
                {TEMPLATE_VARS.map((v) => (
                  <button key={v} className="chip" onClick={(e) => {
                    const input = (e.target as HTMLElement).closest('.ct')?.querySelector('.inp') as HTMLInputElement;
                    if (input) {
                      input.value += `{${v}}`;
                      setTemplate(input.value);
                    }
                  }}>{`{${v}}`}</button>
                ))}
              </div>
              <div className="range">
                预览 <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--accent-text)', background: 'var(--accent-soft)', borderRadius: 6, padding: '3px 8px' }}>{previewFilename(settings.namingTemplate)}</span>
              </div>
            </div>
          </div>
          <div className="srow">
            <div className="lb">保存位置</div>
            <div className="ct">
              <div className="seg" style={{ alignSelf: 'flex-start' }}>
                {([['default', '默认目录'], ['ask', '每次询问'], ['fixed', '固定目录']] as const).map(([v, label]) => (
                  <button key={v} className={`opt ${settings.saveMode === v ? 'on' : ''}`} onClick={() => void update({ saveMode: v })}>{label}</button>
                ))}
              </div>
              {settings.saveMode !== 'ask' && (
                <div className="range">
                  子目录 <input className="inp" style={{ width: 150, fontFamily: 'inherit' }} defaultValue={settings.subDirectory} onBlur={(e) => void update({ subDirectory: e.target.value.replace(/[/\\]/g, '').slice(0, 64) })} />
                </div>
              )}
              <div className="range" style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
                ~/Downloads{settings.subDirectory ? `/${settings.subDirectory}` : ''} <span style={{ color: 'var(--text-3)' }}>（只读 · 仅支持一层子目录）</span>
              </div>
              <div className="range">
                同名文件
                <div className="seg">
                  {([['rename', '自动加序号'], ['overwrite', '覆盖'], ['skip', '跳过']] as const).map(([v, label]) => (
                    <button key={v} className={`opt ${settings.conflictPolicy === v ? 'on' : ''}`} onClick={() => {
                      if (v === 'overwrite') {
                        openConfirm({
                          message: '覆盖策略会直接覆盖同名文件，此操作不可逆。确认启用？',
                          danger: true,
                          onConfirm: () => { void update({ conflictPolicy: v }); closeConfirm(); },
                        });
                      } else void update({ conflictPolicy: v });
                    }}>{label}</button>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <div className="srow">
            <div className="lb">音频输出</div>
            <div className="ct">
              <div className="seg" style={{ alignSelf: 'flex-start' }}>
                {([['original', '保留原始'], ['mp3', '转为 MP3']] as const).map(([v, label]) => (
                  <button key={v} className={`opt ${settings.audioOutput === v ? 'on' : ''}`} onClick={() => void update({ audioOutput: v })}>{label}</button>
                ))}
              </div>
              <div className="note" style={{ marginTop: 6 }}>
                {settings.audioOutput === 'mp3'
                  ? '默认方案：音频统一转 MP3（192kbps），兼容性最好（车载/U 盘/剪辑软件）。代价：有损转码（AAC→MP3 二次编码）'
                  : '保留站点原始格式（m4a/mp3…），无损。但部分站点（如 QQ音乐）的音频会被 Chrome 判成视频而改名为 .mp4，遇到时请改回「转为 MP3」'}
              </div>
            </div>
          </div>
          <div className="srow">
            <div className="lb" />
            <div className="ct" style={{ gap: 9 }}>
              <button className="switchrow" style={{ border: 'none', background: 'transparent', padding: 0 }} onClick={() => {
                if (!settings.quickDownload) {
                  openConfirm({
                    message: '开启「点击条目直接快速下载」后，单击列表条目即开始下载，易误触。确认开启？',
                    onConfirm: () => { void update({ quickDownload: true }); closeConfirm(); },
                  });
                } else void update({ quickDownload: false });
              }}>
                <span className={`sw2 ${settings.quickDownload ? 'on' : ''}`} />点击条目直接快速下载<span style={{ color: 'var(--warn)', fontSize: 11 }}>（易误触，开启需确认）</span>
              </button>
              <button className="switchrow" style={{ border: 'none', background: 'transparent', padding: 0 }} onClick={() => void update({ notifyOnComplete: !settings.notifyOnComplete })}>
                <span className={`sw2 ${settings.notifyOnComplete ? 'on' : ''}`} />任务完成时发送系统通知
              </button>
            </div>
          </div>
        </div>

        {/* 转换设置（F-504 摘要级）+ 引擎入口 */}
        <div className="group-title" style={{ marginBottom: 4 }}>转换设置 · 通用设置<span className="ln" /></div>
        <div className="group-card">
          <div className="srow">
            <div className="lb">输出预设</div>
            <div className="ct">
              {settings.convertPresets.map((p) => (
                <div className="domrow" key={p.id} style={{ fontFamily: 'inherit' }}>
                  <span>{p.name}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{p.container}{p.resolution ? ` · ${p.resolution}` : ''}</span>
                </div>
              ))}
              <div className="note"><InfoIcon />转换执行需本地处理引擎 · <a style={{ color: 'var(--accent-text)', textDecoration: 'underline', cursor: 'pointer' }} onClick={onOpenEngine}>查看引擎状态</a></div>
            </div>
          </div>
          <div className="srow">
            <div className="lb">外观</div>
            <div className="ct">
              <div className="seg" style={{ alignSelf: 'flex-start' }}>
                {([['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']] as const).map(([v, label]) => (
                  <button key={v} className={`opt ${settings.theme === v ? 'on' : ''}`} onClick={() => void update({ theme: v })}>{label}</button>
                ))}
              </div>
              <div className="note" style={{ marginTop: 6 }}>
                {settings.theme === 'system'
                  ? `正在跟随系统外观：当前为${systemDark ? '深色' : '浅色'}（系统切换时自动跟随）`
                  : `已固定为${settings.theme === 'dark' ? '深色' : '浅色'}，不随系统变化`}
              </div>
            </div>
          </div>
          <div className="srow">
            <div className="lb">导入导出</div>
            <div className="ct">
              <div className="chips">
                <button className="chip" style={{ fontFamily: 'inherit' }} onClick={() => {
                  void (async () => {
                    const r = await send<{ settings: Settings }>(MSG.EXPORT_SETTINGS);
                    const blob = new Blob([JSON.stringify(r.settings, null, 2)], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    await chrome.downloads.download({ url, filename: 'mediasniff-settings.json' });
                    setTimeout(() => URL.revokeObjectURL(url), 5000);
                    showToast('设置已导出');
                  })();
                }}>导出设置</button>
                <label className="chip add" style={{ fontFamily: 'inherit' }}>
                  导入设置
                  <input type="file" accept=".json" style={{ display: 'none' }} onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    void (async () => {
                      try {
                        const obj = JSON.parse(await file.text()) as Partial<Settings>;
                        await send(MSG.IMPORT_SETTINGS, obj);
                        showToast('设置已导入，建议重新打开浮层');
                      } catch {
                        showToast('导入失败：文件格式不合法', 'err');
                      }
                    })();
                  }} />
                </label>
              </div>
            </div>
          </div>
          <div className="srow">
            <div className="lb">隐私</div>
            <div className="ct">
              <div className="note"><InfoIcon />全程本地处理：不采集浏览数据，不上传任何媒体内容与地址。所有日志仅存本机。</div>
            </div>
          </div>
        </div>
      </div>

      <div className="set-foot">
        <button className="fk" onClick={onOpenLog}><ListIcon />运行日志</button>
        <button className="fk" onClick={onOpenAbout}><InfoIcon />关于与合规</button>
        <button className="fk" onClick={() => openConfirm({
          message: '恢复默认设置？当前全部自定义配置将被清除。',
          danger: true,
          onConfirm: () => {
            void (async () => {
              await send(MSG.RESET_SETTINGS);
              showToast('已恢复默认设置');
              closeConfirm();
              setTimeout(() => location.reload(), 600);
            })();
          },
        })}><ResetIcon />恢复默认设置</button>
      </div>

      {/* 二次确认浮层（IX-07） */}
      {confirmState && (
        <div className="overlay" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.32)' }} onClick={closeConfirm}>
          <div className="dlg" style={{ margin: 0, width: 300, background: 'var(--panel)' }} onClick={(e) => e.stopPropagation()}>
            <h5>{confirmState.danger ? '⚠️ ' : ''}确认操作</h5>
            <p>{confirmState.message}</p>
            <div className="acts">
              <button className="btn line" onClick={closeConfirm}>取消</button>
              <button className="btn" onClick={confirmState.onConfirm}>{confirmState.confirmLabel ?? '确认'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
