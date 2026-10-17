import { describe, expect, mock, test } from 'claude-code/testing';
import type { On } from 'claude-code';
import { todayPrefix, pad3, planEvict } from './register';

// 测试宿主不自带事件底座：事件由测试回答（在所有插件之下），
// mod 钩子在其上方跑，改写与副作用从链上验证。
const bottom = (on: On) => {
  mock.store(on);
  on('prompt.submit', ($, e) => ({ text: e.text }));
  on('session.start', ($, e) => ({ cwd: e.cwd }));
  on('tool.register', () => ({ value: { tool: 'mcp__token-inbox__vault-apply' } }));
  on('command.register', () => ({ value: { command: 'token-flush' } }));
};

describe('token-inbox', () => {
  test('带 token 的消息：发出的文本只含占位符，真值不出现在链上', async ($, on) => {
    bottom(on);
    const token = 'ghp_' + 'A'.repeat(36);
    const r = await $.prompt.submit({ text: `帮我配置 gh，token 是 ${token}`, wait: false, origin: { kind: 'composer' } });
    if ('drop' in r && r.drop) throw new Error(`不应拦截：${r.drop}`);
    expect(r.text).toBeTruthy();
    expect(r.text).not.toContain(token);
    expect(r.text).toContain(`${todayPrefix()}-001已入箱脱敏`);
  });

  test('无 token 的消息原样通过', async ($, on) => {
    bottom(on);
    const text = '帮我看看这段配置哪里错了';
    const r = await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } });
    if ('drop' in r && r.drop) throw new Error(`不应拦截：${r.drop}`);
    expect(r.text).toBe(text);
  });

  test('超长 token：超出标称长度的尾部也不得漏', async ($, on) => {
    bottom(on);
    // 真实案例：55 字符假 token，精确长度正则只掐前 40 位，尾部 19 字符漏网
    const token = 'ghp_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz012';
    const r = await $.prompt.submit({ text: `帮我配 gh，token 是 ${token}`, wait: false, origin: { kind: 'composer' } });
    if ('drop' in r && r.drop) throw new Error(`不应拦截：${r.drop}`);
    expect(r.text).not.toContain('klmnopqrstuvwxyz012');
    expect(r.text).not.toContain(token);
    expect(r.text).not.toMatch(/ghp_[A-Za-z0-9]/);
  });

  test('落值工具：真值写入目标文件，返回给模型的文本不含明文', async ($, on) => {
    bottom(on);
    let written: { path: string; text: string } | undefined;
    on('fs.write', ($, e) => {
      written = { path: e.path, text: e.text };
      return { value: undefined };
    });
    await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false });
    const token = 'glpat-' + 'x'.repeat(20);
    await $.prompt.submit({ text: `token：${token}`, wait: false, origin: { kind: 'composer' } });
    const r = await $.tool.call({ tool: 'mcp__token-inbox__vault-apply', target: '/tmp/vault-apply-test.env' });
    expect(written?.path).toBe('/tmp/vault-apply-test.env');
    expect(written?.text).toBe(`TOKEN=${token}\n`);
    expect(JSON.stringify(r)).not.toContain(token);
    expect(JSON.stringify(r)).toContain('已写入');
  });

  test('同一 token 重复发送：去重，引用既有编号，不新增存储', async ($, on) => {
    bottom(on);
    const token = 'sk-' + 'd'.repeat(25);
    await $.prompt.submit({ text: `token：${token}`, wait: false, origin: { kind: 'composer' } });
    const r2 = await $.prompt.submit({ text: `再来一次 ${token}`, wait: false, origin: { kind: 'composer' } });
    if ('drop' in r2 && r2.drop) throw new Error(`不应拦截：${r2.drop}`);
    expect(r2.text).not.toContain(token);
    expect(r2.text).toContain(`${todayPrefix()}-001已入箱脱敏`); // 复用当天既有编号
  });

  test('单日额度：第 1001 个新值触发拦截并提示 /token-flush，额度内去重不受影响', async ($, on) => {
    bottom(on);
    // 一条消息灌满当日 1000 个额度：宿主单用例 5s 超时，1000 次独立 submit 是 O(n²) 必超时
    const fill = (i: number) => `sk-fill${i}-${'x'.repeat(20)}`;
    const bulk = await $.prompt.submit({ text: `t：${Array.from({ length: 1000 }, (_, i) => fill(i)).join(' ')}`, wait: false, origin: { kind: 'composer' } });
    if ('drop' in bulk && bulk.drop) throw new Error(`额度内不应拦截：${bulk.drop}`);
    expect(bulk.text).toContain(`${todayPrefix()}-1000已入箱脱敏`);
    // 额度已满时，已有 token 的重复发送仍正常去重
    const dupR = await $.prompt.submit({ text: `t：${fill(999)}`, wait: false, origin: { kind: 'composer' } });
    if ('drop' in dupR && dupR.drop) throw new Error(`去重不应拦截：${dupR.drop}`);
    expect(dupR.text).toContain(`${todayPrefix()}-1000已入箱脱敏`);
    // 新值 → 整体拦截，指路恢复命令
    const r = await $.prompt.submit({ text: `t：sk-new-${'z'.repeat(24)}`, wait: false, origin: { kind: 'composer' } });
    expect('drop' in r && r.drop).toContain('/token-flush');
  });

  test('/token-flush 恢复：清空后当天编号从 001 重新开始', async ($, on) => {
    bottom(on);
    const token = 'glpat-' + 'b'.repeat(20);
    await $.prompt.submit({ text: `token：${token}`, wait: false, origin: { kind: 'composer' } });
    const r = await $.command.run({ command: 'token-flush', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } });
    expect(r.text).toContain('已清空');
    expect(r.text).toContain('1 个');
    const r2 = await $.prompt.submit({ text: `token：${token}`, wait: false, origin: { kind: 'composer' } });
    if ('drop' in r2 && r2.drop) throw new Error(`不应拦截：${r2.drop}`);
    expect(r2.text).toContain(`${todayPrefix()}-001已入箱脱敏`);
  });
});

describe('token-inbox 纯函数', () => {
  test('todayPrefix：本地日期 YYYYMMDD', async () => {
    expect(todayPrefix(new Date('2026-10-17T15:00:00'))).toBe('20261017');
    expect(todayPrefix(new Date('2026-01-02T00:30:00'))).toBe('20260102');
  });

  test('pad3：三位定宽补零', async () => {
    expect(pad3(1)).toBe('001');
    expect(pad3(42)).toBe('042');
    expect(pad3(999)).toBe('999');
  });

  test('planEvict：未超限返回空，超限按字符串序淘汰最旧', async () => {
    expect(planEvict(['20261017-001'], 1000)).toEqual([]);
    const nums = ['20261016-003', '20261017-001', '20261016-001', '20261016-002'];
    expect(planEvict(nums, 4)).toEqual([]);
    expect(planEvict(nums, 3)).toEqual(['20261016-001']);
    expect(planEvict(nums, 2)).toEqual(['20261016-001', '20261016-002']);
  });

  test('planEvict：不修改入参', async () => {
    const nums = ['20261017-002', '20261017-001'];
    planEvict(nums, 1);
    expect(nums).toEqual(['20261017-002', '20261017-001']);
  });
});
