import type { Register } from 'claude-code';

// 当日本地日期前缀（YYYYMMDD）。编号按天分区，跨天自动重新从 001 计数。
export const todayPrefix = (d = new Date()): string => {
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
};

export const pad3 = (n: number): string => String(n).padStart(3, '0');

// 全箱 FIFO 淘汰计划：日期与序号均定宽，编号字符串排序即时间序，
// 超出上限时淘汰最旧的一批。抽成纯函数直接单测——事件级构造 >1000 键
// 需要真实跨日时钟，不值得为此引入时钟注入。
export const planEvict = (nums: string[], cap: number): string[] =>
  nums.length <= cap ? [] : [...nums].sort().slice(0, nums.length - cap);

// 常见 token 形态：GitHub PAT（经典/细粒度/各前缀）、Anthropic key、通用 sk-、
// GitLab PAT、Slack token。长度取下限贪婪匹配——超出标称长度的尾部一并截获，
// 不假设 token 恰好是文档标称长度。命中即截获入箱，原文中的值全部替换为占位符。
const TOKEN_RE =
  /(ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghu_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{24,}|sk-[A-Za-z0-9_-]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/g;

export const register: Register = (on) => {
  // 模型可调用的落值工具：参数只有目标路径和变量名，值始终留在本地保险箱。
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'vault-apply',
      description:
        '把用户存入本地保险箱的 token 写入目标文件（一行 KEY=value）。token 的值对模型不可见，模型只提供路径和变量名。',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '目标文件的绝对路径' },
          key: { type: 'string', description: '变量名，默认 TOKEN' },
          index: { type: 'number', description: '第几个入箱的 token，默认 1' },
        },
        required: ['target'],
      },
    });
    await $.command.register({
      name: 'token-flush',
      description: '清空 token-inbox 保险箱中保存的全部 token',
    });
    return next(e);
  });

  // 用户手动清空保险箱。
  on('command.run', { command: 'token-flush' }, async ($, e, next) => {
    const keys = (await $.store.keys()).filter((k) => k.startsWith('token:'));
    for (const k of keys) await $.store.delete(k);
    return { text: `token-inbox：保险箱已清空（删除 ${keys.length} 个 token）` };
  });

  on('tool.call', { tool: 'mcp__token-inbox__vault-apply' }, async ($, e, next) => {
    const args = e as { target?: string; key?: string; index?: number };
    if (!args.target) {
      return { result: '缺少 target 参数' };
    }
    const value = await $.store.get(`token:${args.index ?? 1}`);
    if (typeof value !== 'string' || !value) {
      return { result: '保险箱里没有这个 token：请用户把 token 直接发在消息里，会自动入箱脱敏' };
    }
    const key = args.key ?? 'TOKEN';
    await $.fs.write(args.target, `${key}=${value}\n`);
    return { result: `已写入 ${key}=***（${value.length} 字符）到 ${args.target}，值未经过模型` };
  });

  // 入口脱敏：带 token 的消息在进入会话前把值换成占位符，
  // 模型与 transcript 从头到尾只见占位符，真值进 $.store。
  // 去重：同一真值只存一次，重复出现引用既有编号。
  // 容量：至多 MAX_TOKENS 个，满了 FIFO 淘汰最旧——$.store 有 4MiB 硬上限，
  // set 一旦 reject，fail-closed 会把带 token 的消息整体拦掉，不能让箱满挡路。
  // 编号只增不复用（nextN = max+1），淘汰腾出的号不补，防止撞上未淘汰的编号。
  const MAX_TOKENS = 100;

  on('prompt.submit', async ($, e, next) => {
    if (e.command) return next(e);
    const found = e.text.match(TOKEN_RE);
    if (!found?.length) return next(e);
    const known = new Map<string, number>(); // 真值 → 编号
    let nextN = 0;
    const oldest: number[] = []; // 现有编号，升序即入箱序
    for (const k of (await $.store.keys()).filter((k) => k.startsWith('token:'))) {
      const v = await $.store.get(k);
      if (typeof v !== 'string') continue;
      const n = Number(k.slice('token:'.length));
      known.set(v, n);
      if (n > nextN) nextN = n;
      oldest.push(n);
    }
    oldest.sort((a, b) => a - b);
    let text = e.text;
    let added = 0;
    let evicted = 0;
    for (const t of found) {
      let n = known.get(t);
      if (n === undefined) {
        if (known.size >= MAX_TOKENS) {
          const evict = oldest.splice(0, known.size - MAX_TOKENS + 1);
          for (const m of evict) {
            await $.store.delete(`token:${m}`);
            for (const [v, k] of known) if (k === m) { known.delete(v); break; }
          }
          evicted += evict.length;
        }
        added += 1;
        nextN += 1;
        n = nextN;
        await $.store.set(`token:${n}`, t);
        known.set(t, n);
      }
      text = text.replace(t, `[token-inbox:第${n}个token已入箱脱敏;需要落值时调用vault-apply]`);
    }
    const dup = found.length - added;
    const parts: string[] = [];
    if (added > 0) parts.push(`新入箱 ${added}`);
    if (dup > 0) parts.push(`去重 ${dup}`);
    if (evicted > 0) parts.push(`淘汰最旧 ${evicted}`);
    $.ui.toast(
      parts.length
        ? `token-inbox：截获 ${found.length} 个 token（${parts.join('，')}）`
        : `token-inbox：截获 ${found.length} 个 token，均已入箱`,
    );
    return next({ ...e, text });
  }).catch(async ($, e, next) => {
    // fail-closed：消息确实含 token 而脱敏没完成时宁可整体拦截，不放原文过。
    if (next.called || !e.text?.match(TOKEN_RE)) return next(e);
    return { drop: 'token-inbox：消息疑似含 token 但脱敏失败，已整体拦截' };
  });
};
