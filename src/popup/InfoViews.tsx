// ============ 运行日志视图（F-508 / P-07）+ 合规/关于视图（F-506/507 / P-06）============
import { useEffect, useState } from 'react';
import { useLogs, useEngine } from './store';
import { BackIcon, SearchIcon } from './icons';
import { formatClock } from '../shared/format';
import { LOCAL_ENGINE_VERSION } from '../shared/types';
import { BUILD_TIME } from '../shared/build-info';
import type { LogEntry } from '../shared/types';

export function LogView({ onBack, refTaskId }: { onBack: () => void; refTaskId?: string }) {
  const [logs, query, clear] = useLogs();
  const [level, setLevel] = useState<'WARN' | 'ALL' | 'ERROR'>('WARN');
  const [keyword, setKeyword] = useState(refTaskId ?? '');

  useEffect(() => {
    void query({ level, keyword });
  }, [level, keyword, query]);

  return (
    <div className="view">
      <div className="logbar">
        <button className="back" onClick={onBack}><BackIcon />返回设置</button>
        <span className="tt">运行日志</span>
        <button className="ghost-btn" onClick={() => void clear()}>清空</button>
        <button className="ghost-btn" onClick={() => {
          const text = logs.map((l) => `${formatClock(l.t)} [${l.level}] ${l.module}: ${l.msg}${l.detail ? ` (${l.detail})` : ''}`).join('\n');
          void navigator.clipboard.writeText(text);
        }}>导出</button>
      </div>
      <div className="toolbar" style={{ paddingBottom: 2 }}>
        <div className="seg">
          {([['WARN', 'WARN 及以上'], ['ALL', '全部'], ['ERROR', '仅错误']] as const).map(([v, label]) => (
            <button key={v} className={`opt ${level === v ? 'on' : ''}`} onClick={() => setLevel(v)}>{label}</button>
          ))}
        </div>
      </div>
      <div className="search">
        <SearchIcon />
        <input placeholder="搜索关键字" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
      </div>
      <div className="loglist">
        {logs.length === 0 && <div className="logend">暂无日志</div>}
        {logs.map((l: LogEntry, i) => (
          <div className="log" key={i}>
            <div className="l1">
              <span className="tm">{formatClock(l.t)}</span>
              <span className={`lv ${l.level === 'ERROR' ? 'err' : l.level === 'WARN' ? 'warn' : 'info'}`}>{l.level}</span>
              <span className="mod">{l.module}</span>
              <span className="msg">{l.msg}</span>
            </div>
            {l.detail && <div className="l2">{l.detail}</div>}
          </div>
        ))}
        {logs.length > 0 && <div className="logend">—— 共 {logs.length} 条 ——</div>}
      </div>
      {/* 构建时间：用于确认浏览器里实际加载的是哪一版（扩展需手动重新加载才生效） */}
      <div className="note" style={{ padding: '6px 12px', borderTop: '1px solid var(--border)' }}>
        当前版本构建于 {BUILD_TIME} · 若与最新构建不符，请在扩展管理页点「重新加载」
      </div>
    </div>
  );
}

// ---------- 合规确认（首用）与关于 ----------
export function ComplianceView({ confirmed, onConfirm, mode }: { confirmed: boolean; onConfirm: () => void; mode: 'gate' | 'about' }) {
  const [engine] = useEngine();
  const [checked, setChecked] = useState(confirmed);

  return (
    <div className="view">
      <div className="set-body" style={{ paddingTop: 14 }}>
        <div className="dlg" style={{ margin: 0 }}>
          <h5 style={{ fontWeight: 700 }}>使用须知</h5>
          <p style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>· 本扩展用于保存你有权访问与使用的媒体内容</span>
            <span>· 请仅下载拥有合法使用权的内容，并遵守目标站点的服务条款与当地法律</span>
            <span>· 不支持受 DRM 保护的内容；不提供任何绕过能力</span>
            <span>· 全程本地处理：不采集浏览数据，不上传任何媒体内容与地址</span>
          </p>
          {!confirmed && mode === 'gate' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 11, fontSize: 12.5 }}>
              <button className={`cbx ${checked ? 'on' : ''}`} onClick={() => setChecked(!checked)} aria-label="我已阅读并理解上述内容" />
              我已阅读并理解上述内容
              <button className="btn" style={{ marginLeft: 'auto', padding: '5.5px 14px', fontSize: 11.5 }} disabled={!checked} onClick={onConfirm}>确认并继续</button>
            </div>
          )}
          {confirmed && mode === 'about' && (
            <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--text-3)' }}>
              已确认 · 版本 1.0 · MediaSniff（媒探）· 无付费墙 · 无账号 · 无远端上报
            </div>
          )}
        </div>

        {/* 引擎状态卡（F-401 / P-06） */}
        <div className="group-title" style={{ marginTop: 4 }}>处理引擎状态<span className="ln" /></div>
        <div className="engcard">
          <div className="e1">
            <span className={`dot ${engine?.browser === 'ready' ? 'ok' : 'warn'}`} />
            浏览器内引擎
            <span className={`st ${engine?.browser === 'ready' ? 'ok' : 'warn'}`}>
              {engine?.browser === 'ready' ? `● 就绪 · v${LOCAL_ENGINE_VERSION}` : '● 加载中'}
            </span>
          </div>
          <div className="cap">支持：合并封装、分片合并、加密流解密</div>
          <div className="sub">无需安装，随扩展内置</div>
        </div>
        <LocalEngineCard />
        <div className="statelabels">
          <span className="tag res">ready · 绿</span>
          <span className="tag enc">installed_unregistered · 黄</span>
          <span className="tag" style={{ background: 'var(--info-soft)', color: 'var(--text-2)' }}>not_installed · 灰</span>
          <span className="tag enc">version_mismatch · 黄＋版本对比</span>
        </div>
      </div>
    </div>
  );
}

function LocalEngineCard() {
  const [engine, probe] = useEngine();
  const st = engine?.local ?? 'not_installed';
  const [probing, setProbing] = useState(false);
  const meta =
    st === 'ready'
      ? { dot: 'ok', label: `● 已连接${engine?.localVersion ? ` · v${engine.localVersion}` : ''}`, cls: 'ok' }
      : st === 'installed_unregistered'
        ? { dot: 'warn', label: '○ 已安装，未注册', cls: 'warn' }
        : st === 'version_mismatch'
          ? { dot: 'warn', label: `○ 版本不匹配（当前 v${engine?.localVersion ?? '?'}，需 v${LOCAL_ENGINE_VERSION}）`, cls: 'warn' }
          : { dot: 'off', label: '○ 未安装', cls: 'off' };

  return (
    <div className="engcard" style={st === 'ready' ? undefined : { borderColor: 'var(--warn)' }}>
      <div className="e1">
        <span className={`dot ${meta.dot}`} />
        本地引擎
        <span className={`st ${meta.cls}`}>{meta.label}</span>
      </div>
      <div className="cap">支持：格式转码、本地文件转换、超大文件</div>
      {st === 'ready' ? (
        <div className="sub">全部转换能力可用</div>
      ) : (
        <>
          <div className="sub">ⓘ {st === 'installed_unregistered' ? '需要完成浏览器注册后才能使用：' : '安装本地引擎后可解锁转码与大文件能力：'}</div>
          <div className="cmdline"><span className="p">$</span> mediasniff-engine install</div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button
              className="btn line"
              style={{ fontSize: 11.5 }}
              disabled={probing}
              onClick={() => {
                setProbing(true);
                void probe().finally(() => setProbing(false));
              }}
            >
              {probing ? '检测中…' : '已执行，重新检测'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
