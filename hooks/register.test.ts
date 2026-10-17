import { describe, expect, mock, test } from 'claude-code/testing';
import type { On } from 'claude-code';

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
    expect(r.text).toContain('token-inbox');
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
    expect(r2.text).toContain('第1个'); // 复用编号而非新增第2个
  });

  test('/token-flush 清空保险箱后，同 token 重新从第1个编号', async ($, on) => {
    bottom(on);
    const token = 'glpat-' + 'b'.repeat(20);
    await $.prompt.submit({ text: `token：${token}`, wait: false, origin: { kind: 'composer' } });
    const r = await $.command.run({ command: 'token-flush', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } });
    expect(r.text).toContain('已清空');
    expect(r.text).toContain('1 个');
    const r2 = await $.prompt.submit({ text: `token：${token}`, wait: false, origin: { kind: 'composer' } });
    if ('drop' in r2 && r2.drop) throw new Error(`不应拦截：${r2.drop}`);
    expect(r2.text).toContain('第1个');
  });

  test('超过上限：淘汰最旧，新编号不复用被淘汰的编号', async ($, on) => {
    bottom(on);
    // 上限 100：灌入 100 个后，第 101 个触发淘汰最旧（token:1）
    const first = 'sk-first-' + 'a'.repeat(20);
    await $.prompt.submit({ text: `t：${first}`, wait: false, origin: { kind: 'composer' } });
    for (let i = 0; i < 99; i++) {
      await $.prompt.submit({ text: `t：sk-fill${i}-${'x'.repeat(20)}`, wait: false, origin: { kind: 'composer' } });
    }
    const r = await $.prompt.submit({ text: `t：sk-new-${'z'.repeat(24)}`, wait: false, origin: { kind: 'composer' } });
    if ('drop' in r && r.drop) throw new Error(`不应拦截：${r.drop}`);
    expect(r.text).toContain('第101个'); // 编号继续增长，不撞被淘汰的 1
    // 最旧的已淘汰：再发它应重新入箱为新编号
    const r2 = await $.prompt.submit({ text: `t：${first}`, wait: false, origin: { kind: 'composer' } });
    if ('drop' in r2 && r2.drop) throw new Error(`不应拦截：${r2.drop}`);
    expect(r2.text).toContain('第102个');
  });
});
