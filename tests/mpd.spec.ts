// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { parseMpd, expandSegments } from '../src/background/parser/mpd';

const MPD_MULTI = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT1H2M3S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>
      <Representation id="v1080" bandwidth="4500000" width="1920" height="1080" codecs="avc1.640028"/>
      <Representation id="v720" bandwidth="2500000" width="1280" height="720" codecs="avc1.64001f"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="zh">
      <Representation id="a128" bandwidth="128000" audioSamplingRate="48000" codecs="mp4a.40.2">
        <AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

const MPD_TEMPLATE = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT30S">
  <Period>
    <AdaptationSet contentType="video">
      <Representation id="v1" bandwidth="2000000" width="1280" height="720">
        <SegmentTemplate timescale="1000" duration="10000" startNumber="1" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/seg-$Number$.m4s"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

const MPD_LIST = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT20S">
  <Period>
    <AdaptationSet contentType="video">
      <Representation id="v1" bandwidth="2000000" width="1280" height="720">
        <SegmentList timescale="1000" duration="10000">
          <Initialization sourceURL="init.mp4"/>
          <SegmentURL media="s1.m4s"/>
          <SegmentURL media="s2.m4s"/>
        </SegmentList>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

describe('parseMpd（F-103 规则 2）', () => {
  it('解析双轨 AdaptationSet + DRM 标记', () => {
    const r = parseMpd(MPD_MULTI, 'https://cdn.example.com/v.mpd');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.live).toBe(false);
    expect(r.doc.durationSec).toBe(3723);
    expect(r.doc.encryption).toBe('drm');
    const videos = r.doc.representations.filter((x) => x.type === 'video');
    const audios = r.doc.representations.filter((x) => x.type === 'audio');
    expect(videos).toHaveLength(2);
    expect(audios).toHaveLength(1);
    expect(audios[0]!.lang).toBe('zh');
  });
  it('type=dynamic 判定直播', () => {
    const t = MPD_TEMPLATE.replace('type="static"', 'type="dynamic"');
    const r = parseMpd(t, 'https://cdn.example.com/v.mpd');
    if (!r.ok) throw new Error('expect ok');
    expect(r.doc.live).toBe(true);
  });
  it('无 ContentProtection 时 encryption=none', () => {
    const r = parseMpd(MPD_TEMPLATE, 'https://x/v.mpd');
    if (!r.ok) throw new Error('expect ok');
    expect(r.doc.encryption).toBe('none');
  });
  it('非 DASH 内容返回 error（E-002）', () => {
    expect(parseMpd('not xml at all <', 'https://x/v.mpd').ok).toBe(false);
    expect(parseMpd('<html><body>404</body></html>', 'https://x/v.mpd').ok).toBe(false);
  });
});

describe('expandSegments（SegmentTemplate $Number$ 展开）', () => {
  it('按 duration 生成完整分片序列', () => {
    const r = parseMpd(MPD_TEMPLATE, 'https://cdn.example.com/dash/manifest.mpd');
    if (!r.ok) throw new Error('expect ok');
    const rep = r.doc.representations[0]!;
    const segs = expandSegments(rep, 'https://cdn.example.com/dash/manifest.mpd');
    expect(segs.initUrl).toBe('https://cdn.example.com/dash/v1/init.mp4');
    expect(segs.segmentUrls).toEqual([
      'https://cdn.example.com/dash/v1/seg-1.m4s',
      'https://cdn.example.com/dash/v1/seg-2.m4s',
      'https://cdn.example.com/dash/v1/seg-3.m4s',
    ]);
    expect(segs.avgSegmentDur).toBeCloseTo(10, 3);
  });
  it('SegmentList 显式 URL', () => {
    const r = parseMpd(MPD_LIST, 'https://cdn.example.com/l/manifest.mpd');
    if (!r.ok) throw new Error('expect ok');
    const segs = expandSegments(r.doc.representations[0]!, 'https://cdn.example.com/l/manifest.mpd');
    expect(segs.initUrl).toBe('https://cdn.example.com/l/init.mp4');
    expect(segs.segmentUrls).toEqual(['https://cdn.example.com/l/s1.m4s', 'https://cdn.example.com/l/s2.m4s']);
  });
});
