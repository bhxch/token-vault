# token-vault 每日编号重设计 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 vault-apply 两条写错值路径（index 缺省静默落错值、FIFO 淘汰后猜编号），编号改为 `YYYYMMDD-NNN` 每日 001 起，清理改为 1000 键全局 FIFO，单日超限 fail-closed。

**Architecture:** 全部改动在 `hooks/register.ts` 单文件：新增三个导出纯函数（`todayPrefix`/`pad3`/`planEvict`）供直接单测，重写 `prompt.submit` 与 `vault-apply` 两个 handler，微调 `session.start` 注册与 `token-flush` 文案。测试走 `claude plugin test` 事件级宿主。

**Tech Stack:** TypeScript（Claude Code mod hooks，`claude-code` / `claude-code/testing` 类型与测试宿主），无新依赖。

**规约：**

- 测试命令一律：`claude plugin test /share/rw/repo/tools/mods/token-vault`（无单用例过滤语法，跑全量）
- 在仓库根目录 `/share/rw/repo/tools/mods/token-vault` 直接工作（本仓库无分支工作流，直接提交 main）
- 测试文件里新增导入：`import { todayPrefix, pad3, planEvict } from './register';`
  （若运行器报找不到模块，改为 `'./register.ts'` 再跑）
- 已知取舍（用户已拍板）：第 1000 个 token 编号为 `-1000`（四位，超出 NNN），不做特判；单日超限拦截保证不会出现第 1001 个
- 任务 2 的 1000 次循环用例预计运行 5~15 秒，属正常

---

### Task 1: 纯函数 todayPrefix / pad3 / planEvict

**Files:**
- Modify: `hooks/register.ts`（文件头部，TOKEN_RE 之前）
- Test: `hooks/register.test.ts`（文件末尾追加新 describe）

- [ ] **Step 1: 写失败测试**

在 `hooks/register.test.ts` 顶部 import 区加：

```ts
import { todayPrefix, pad3, planEvict } from './register';
```

文件末尾（最外层 describe 之后）追加：

```ts
describe('token-vault 纯函数', () => {
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `claude plugin test /share/rw/repo/tools/mods/token-vault`
Expected: FAIL——导入的三个函数不存在（编译/导入错误，或全部新用例 fail）

- [ ] **Step 3: 最小实现**

在 `hooks/register.ts` 的 `TOKEN_RE` 定义之前插入：

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `claude plugin test /share/rw/repo/tools/mods/token-vault`
Expected: 7 个旧用例 + 4 个新用例全 PASS

- [ ] **Step 5: 提交**

```bash
git add hooks/register.ts hooks/register.test.ts
git commit -m "feat: 新增日期编号纯函数 todayPrefix/pad3/planEvict

每日编号与全箱 FIFO 的基础构件，抽成纯函数以便脱离事件宿主直接单测。

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 入箱重写——每日编号、当天去重、全箱 FIFO、单日额度

**Files:**
- Modify: `hooks/register.ts`（`prompt.submit` handler 整体重写；`tool.call` handler 查找段最小补丁）
- Test: `hooks/register.test.ts`（改 3 处断言、删 1 个旧用例、增 2 个新用例）

- [ ] **Step 1: 更新测试（先让它失败）**

用例 1「带 token 的消息」：把 `expect(r.text).toContain('token-vault');` 替换为：

```ts
    expect(r.text).toContain(`${todayPrefix()}-001已入箱脱敏`);
```

用例 5「同一 token 重复发送」：把 `expect(r2.text).toContain('第1个');` 及其行尾注释替换为：

```ts
    expect(r2.text).toContain(`${todayPrefix()}-001已入箱脱敏`); // 复用当天既有编号
```

删除用例 6「/token-flush 清空保险箱后，同 token 重新从第1个编号」整块（下面新用例组里的「/token-flush 恢复」是其替代，断言更强）。

删除用例 7「超过上限：淘汰最旧，新编号不复用被淘汰的编号」整块，原位替换为以下两个用例：

```ts
  test('单日额度：第 1001 个新值触发拦截并提示 /token-flush，额度内去重不受影响', async ($, on) => {
    bottom(on);
    for (let i = 0; i < 1000; i++) {
      const r = await $.prompt.submit({ text: `t：sk-fill${i}-${'x'.repeat(20)}`, wait: false, origin: { kind: 'composer' } });
      if ('drop' in r && r.drop) throw new Error(`额度内不应拦截：${r.drop}`);
    }
    // 额度已满时，已有 token 的重复发送仍正常去重
    const dupR = await $.prompt.submit({ text: `t：sk-fill999-${'x'.repeat(20)}`, wait: false, origin: { kind: 'composer' } });
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
```

（最终该文件含 7 个事件级用例 + 4 个纯函数用例：带 token、无 token、超长、落值、去重、单日额度、/token-flush 恢复。）

- [ ] **Step 2: 跑测试确认失败**

Run: `claude plugin test /share/rw/repo/tools/mods/token-vault`
Expected: FAIL——旧实现占位符是 `第1个`，新断言找不到 `YYYYMMDD-NNN` 格式

- [ ] **Step 3: 重写 prompt.submit + 最小补丁 tool.call**

把 `register.ts` 中 `// 编号只增不复用……` 注释、`const MAX_TOKENS = 100;`、整个 `on('prompt.submit', ...)` 块（含 `.catch`）替换为：

```ts
  // 入口脱敏：带 token 的消息在进入会话前把值换成占位符，真值进 $.store，
  // 模型与 transcript 从头到尾只见占位符。
  // 编号 YYYYMMDD-NNN：按天分区，每日从 001 起、当天内只增不复用；
  // 日期与序号均定宽，字符串排序即时间序。去重仅当天范围，跨天重发入新编号。
  // 全箱至多 MAX_KEYS 个键，超出按时间序 FIFO 淘汰最旧（无墓碑，查不到即没有）。
  // 单日新值将超过 MAX_PER_DAY 时 fail-closed 整体拦截，由用户 /token-flush 恢复。
  // 已知取舍：第 1000 个编号为 -1000（四位），不做特判（用户确认暂不考虑）。
  const MAX_PER_DAY = 1000;
  const MAX_KEYS = 1000;

  on('prompt.submit', async ($, e, next) => {
    if (e.command) return next(e);
    const found = e.text.match(TOKEN_RE);
    if (!found?.length) return next(e);
    const today = todayPrefix();
    const known = new Map<string, string>(); // 真值 → 编号（仅当天）
    const nums: string[] = []; // 全箱编号，字符串升序即时间序
    let nextN = 0;
    for (const k of await $.store.keys()) {
      if (!k.startsWith('token:')) continue;
      const n = k.slice('token:'.length);
      nums.push(n);
      if (n.startsWith(`${today}-`)) {
        const v = await $.store.get(k);
        if (typeof v === 'string') known.set(v, n);
        const m = Number(n.slice(today.length + 1));
        if (m > nextN) nextN = m;
      }
    }
    // 单日额度预检：本条消息的全部新值都要能入箱才动手，避免拦一半留一半。
    const fresh = new Set(found.filter((t) => !known.has(t)));
    if (known.size + fresh.size > MAX_PER_DAY) {
      return {
        drop: `token-vault：今日脱敏额度已满（${MAX_PER_DAY}），信息脱敏不可用；请执行 /token-flush 清空保险箱后重试`,
      };
    }
    let text = e.text;
    let added = 0;
    for (const t of found) {
      let n = known.get(t);
      if (n === undefined) {
        added += 1;
        nextN += 1;
        n = `${today}-${pad3(nextN)}`;
        await $.store.set(`token:${n}`, t);
        nums.push(n);
        known.set(t, n);
      }
      text = text.replace(t, `[token-vault:${n}已入箱脱敏;需要落值时调用vault-apply并传此编号]`);
    }
    const evicted = planEvict(nums, MAX_KEYS);
    for (const n of evicted) await $.store.delete(`token:${n}`);
    const dup = found.length - added;
    const parts: string[] = [];
    if (added > 0) parts.push(`新入箱 ${added}`);
    if (dup > 0) parts.push(`去重 ${dup}`);
    if (evicted.length > 0) parts.push(`淘汰最旧 ${evicted.length}`);
    $.ui.toast(
      parts.length
        ? `token-vault：截获 ${found.length} 个 token（${parts.join('，')}）`
        : `token-vault：截获 ${found.length} 个 token，均已入箱`,
    );
    return next({ ...e, text });
  }).catch(async ($, e, next) => {
    // fail-closed：消息确实含 token 而脱敏没完成时宁可整体拦截，不放原文过。
    if (next.called || !e.text?.match(TOKEN_RE)) return next(e);
    return { drop: 'token-vault：消息疑似含 token 但脱敏失败，已整体拦截' };
  });
```

同文件 `on('tool.call', ...)` handler 里，把查找段：

```ts
    const value = await $.store.get(`token:${args.index ?? 1}`);
    if (typeof value !== 'string' || !value) {
      return { result: '保险箱里没有这个 token：请用户把 token 直接发在消息里，会自动入箱脱敏' };
    }
```

替换为（过渡版：显式编号直查、省略时仅箱内唯一才落地；严格化报错在 Task 3 补全）：

```ts
    // 过渡版查找：显式编号直查；省略时仅当箱内唯一才落地。
    const keys = (await $.store.keys()).filter((k) => k.startsWith('token:'));
    const value = args.index
      ? await $.store.get(`token:${args.index}`)
      : keys.length === 1
        ? await $.store.get(keys[0])
        : undefined;
    if (typeof value !== 'string' || !value) {
      return { result: '保险箱里没有这个 token：请用户把 token 直接发在消息里，会自动入箱脱敏' };
    }
```

并把该 handler 的 args 类型断言改为 `const args = e as { target?: string; key?: string; index?: string };`（index 从 number 改 string）。

- [ ] **Step 4: 跑测试确认通过**

Run: `claude plugin test /share/rw/repo/tools/mods/token-vault`
Expected: 11 个用例全 PASS（含约 5~15 秒的单日额度循环用例）

- [ ] **Step 5: 提交**

```bash
git add hooks/register.ts hooks/register.test.ts
git commit -m "feat: 入箱改为每日编号并加全箱 FIFO 与单日额度

编号 YYYYMMDD-NNN 每日 001 起当天不复用；去重限当天；全箱 1000 键
FIFO 淘汰最旧；单日新值超 1000 整体拦截并指路 /token-flush。

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: vault-apply 严格化

**Files:**
- Modify: `hooks/register.ts`（`session.start` 注册块；`tool.call` handler 整体重写）
- Test: `hooks/register.test.ts`（新增 5 个用例）

- [ ] **Step 1: 写失败测试**

在事件级 describe 内（`bottom` 相关用例之后）追加：

```ts
  test('落值：显式编号与短序号补零均落地', async ($, on) => {
    bottom(on);
    on('fs.write', ($, e) => ({ value: undefined }));
    await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false });
    const token = 'gho_' + 'a'.repeat(30);
    await $.prompt.submit({ text: `token：${token}`, wait: false, origin: { kind: 'composer' } });
    const short = await $.tool.call({ tool: 'mcp__token-vault__vault-apply', target: '/tmp/a.env', index: `${todayPrefix()}-1` });
    expect(JSON.stringify(short)).toContain('已写入');
    const padded = await $.tool.call({ tool: 'mcp__token-vault__vault-apply', target: '/tmp/b.env', index: `${todayPrefix()}-001` });
    expect(JSON.stringify(padded)).toContain('已写入');
  });

  test('落值：省略 index 且箱内多个 token → 报错列可用编号，不落地', async ($, on) => {
    bottom(on);
    let wrote = false;
    on('fs.write', ($, e) => {
      wrote = true;
      return { value: undefined };
    });
    await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false });
    await $.prompt.submit({ text: `t1：${'sk-' + 'a'.repeat(23)}`, wait: false, origin: { kind: 'composer' } });
    await $.prompt.submit({ text: `t2：${'sk-' + 'b'.repeat(23)}`, wait: false, origin: { kind: 'composer' } });
    const r = await $.tool.call({ tool: 'mcp__token-vault__vault-apply', target: '/tmp/x.env' });
    expect(wrote).toBe(false);
    const s = JSON.stringify(r);
    expect(s).toContain('index');
    expect(s).toContain('-001');
    expect(s).toContain('-002');
  });

  test('落值：编号不存在 → 报不存在并列可用编号，提示禁止改用', async ($, on) => {
    bottom(on);
    on('fs.write', ($, e) => ({ value: undefined }));
    await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false });
    await $.prompt.submit({ text: `t：${'sk-' + 'c'.repeat(23)}`, wait: false, origin: { kind: 'composer' } });
    const r = await $.tool.call({ tool: 'mcp__token-vault__vault-apply', target: '/tmp/x.env', index: `${todayPrefix()}-002` });
    const s = JSON.stringify(r);
    expect(s).toContain('不存在');
    expect(s).toContain('-001');
    expect(s).toContain('禁止改用');
  });

  test('落值：旧格式纯数字编号 → 报格式错误', async ($, on) => {
    bottom(on);
    on('fs.write', ($, e) => ({ value: undefined }));
    await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false });
    await $.prompt.submit({ text: `t：${'sk-' + 'd'.repeat(23)}`, wait: false, origin: { kind: 'composer' } });
    const r = await $.tool.call({ tool: 'mcp__token-vault__vault-apply', target: '/tmp/x.env', index: '1' });
    expect(JSON.stringify(r)).toContain('YYYYMMDD-NNN');
  });

  test('注册：vault-apply 的 index 参数为 string', async ($, on) => {
    mock.store(on);
    on('prompt.submit', ($, e) => ({ text: e.text }));
    on('session.start', ($, e) => ({ cwd: e.cwd }));
    on('command.register', () => ({ value: { command: 'token-flush' } }));
    let indexType = '';
    on('tool.register', ($, e) => {
      const ev = e as { name?: string; inputSchema?: { properties?: { index?: { type?: string } } } };
      if (ev.name === 'vault-apply') indexType = ev.inputSchema?.properties?.index?.type ?? '';
      return { value: { tool: 'mcp__token-vault__vault-apply' } };
    });
    await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false });
    expect(indexType).toBe('string');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `claude plugin test /share/rw/repo/tools/mods/token-vault`
Expected: FAIL——短序号 `-1` 直查不中、多 token 省略 index 时旧实现静默落 token:1（`wrote` 为 true）、报错文案缺失、schema index 仍为 number

- [ ] **Step 3: 重写 session.start 注册与 tool.call handler**

`session.start` 块替换为：

```ts
  // 模型可调用的落值工具：参数只有目标路径、变量名和入箱编号，值始终留在本地保险箱。
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'vault-apply',
      description:
        '把用户存入本地保险箱的 token 写入目标文件（一行 KEY=value）。token 的值对模型不可见，模型只提供路径、变量名和入箱编号。',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '目标文件的绝对路径' },
          key: { type: 'string', description: '变量名，默认 TOKEN' },
          index: { type: 'string', description: '占位符中的入箱编号，如 20261017-001；箱内仅一个 token 时可省略' },
        },
        required: ['target'],
      },
    });
    await $.command.register({
      name: 'token-flush',
      description: '清空 token-vault 保险箱（当日脱敏额度满或保险箱异常时的恢复手段，日常无需使用）',
    });
    return next(e);
  });
```

`on('tool.call', ...)` 整块替换为：

```ts
  // 落值严格化：编号必须显式且存在，报错列出可用编号并禁止模型改用其他编号。
  // 缺省回退与淘汰后猜编号是"写错值"的全部来源，这里一并堵死。
  on('tool.call', { tool: 'mcp__token-vault__vault-apply' }, async ($, e, next) => {
    const args = e as { target?: string; key?: string; index?: string };
    if (!args.target) {
      return { result: '缺少 target 参数' };
    }
    const nums = (await $.store.keys())
      .filter((k) => k.startsWith('token:'))
      .map((k) => k.slice('token:'.length))
      .sort();
    const today = todayPrefix();
    const avail = () => {
      const ordered = [
        ...nums.filter((n) => n.startsWith(`${today}-`)),
        ...nums.filter((n) => !n.startsWith(`${today}-`)),
      ];
      if (!ordered.length) return '（保险箱为空：请用户把 token 直接发在消息里，会自动入箱脱敏）';
      const shown = ordered.slice(0, 20).join('、');
      return ordered.length > 20 ? `${shown}…等 ${ordered.length} 个` : shown;
    };
    const apply = async (n: string) => {
      const value = await $.store.get(`token:${n}`);
      if (typeof value !== 'string' || !value) return undefined;
      const key = args.key ?? 'TOKEN';
      await $.fs.write(args.target!, `${key}=${value}\n`);
      return `已写入 ${key}=***（${value.length} 字符）到 ${args.target}，值未经过模型`;
    };
    if (!args.index) {
      if (nums.length === 1) {
        const r = await apply(nums[0]);
        if (r) return { result: r };
      }
      return { result: `token-vault：请提供 index（占位符中的入箱编号）。当前可用：${avail()}；禁止改用其他编号落值，缺哪个请让用户重发` };
    }
    const m = args.index.match(/^(\d{8})-(\d{1,3})$/);
    if (!m) {
      return { result: `token-vault：编号格式应为 YYYYMMDD-NNN（如 ${today}-001）` };
    }
    const n = `${m[1]}-${m[2].padStart(3, '0')}`;
    const r = await apply(n);
    if (r) return { result: r };
    return { result: `token-vault：编号 ${n} 不存在（可能已被 FIFO 淘汰）。当前可用：${avail()}；禁止改用其他编号落值，请让用户重发该 token` };
  });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `claude plugin test /share/rw/repo/tools/mods/token-vault`
Expected: 16 个用例全 PASS

- [ ] **Step 5: 提交**

```bash
git add hooks/register.ts hooks/register.test.ts
git commit -m "feat: vault-apply 严格化编号校验

index 改 string 并校验 YYYYMMDD-NNN（短序号补零）；省略 index 仅在
箱内唯一 token 时落地；编号不存在报错列出可用编号并禁止模型改用，
堵死缺省回退与淘汰后猜编号两条写错值路径。

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 文档同步

**Files:**
- Modify: `README.md`（全文替换）
- Modify: `docs/superpowers/specs/2026-10-17-daily-token-index-design.md`（修正一处自审遗漏）

- [ ] **Step 1: 更新 README.md**

全文替换为：

````markdown
# token-vault

把消息里的 token（API 密钥、PAT 等）截入本地保险箱，对模型脱敏：真值不发给后端 LLM，但 Claude Code 可以用——模型调度落值动作，却读不到值。

## 安装

方式一（正式安装，终端会话里）：

```
/plugin install token-vault --marketplace /解包后的目录路径/token-vault
```

方式二（快速试用）：

```
claude --plugin-dir /解包后的目录路径/token-vault
```

## 用法

1. 把 token 直接发在消息里（如「帮我配 gh，token 是 ghp_xxx」），mod 自动截获入箱、消息脱敏，模型只见占位符。编号格式为 `YYYYMMDD-NNN`，每日从 001 起；
2. 告诉 Claude 落值目标和变量名，它会调用 `vault-apply` 并携带占位符里的编号，把真值写进目标文件——返回内容只有长度，没有明文。箱内仅一个 token 时可省略编号；
3. `/token-flush` 仅作恢复手段（当日脱敏额度满或保险箱异常时），日常无需使用。

## 覆盖的 token 格式

`ghp_` / `gho_` / `ghu_` / `ghs_`（GitHub PAT）、`github_pat_`（细粒度 PAT）、`sk-ant-` / `sk-`（API key）、`glpat-`（GitLab）、`xox[baprs]-`（Slack）；长度下限贪婪匹配，超长也全段截获。

## 边界说明

- 真值保存在引擎托管的本地存储（`~/.claude/plugins/store/` 下，明文 JSON），防的是发给后端模型，不防本机其他进程；
- 脱敏发生在入口：已进入会话的历史内容不可改写；
- 保险箱全箱至多 1000 个 token，超出按入箱时间 FIFO 淘汰最旧，被淘汰的编号不再可落值（报错会列出当前可用编号）；
- 单日新 token 至多 1000 个，超出当天消息将被整体拦截，需 `/token-flush` 清空后重试。
````

- [ ] **Step 2: 修正设计文档一处表述**

`docs/superpowers/specs/2026-10-17-daily-token-index-design.md` 「已知边界」第二条：

原文：
```
- 若单日灌满导致编号超出 `NNN` 三位：依赖上一条报错挡住，不会实际发生；
```
替换为：
```
- 恰好第 1000 个编号为 `-1000`（四位，超出 `NNN` 三位）：按用户决定不做特判，可接受；单日额度拦截保证不会有第 1001 个；
```

- [ ] **Step 3: 全量回归**

Run: `claude plugin test /share/rw/repo/tools/mods/token-vault`
Expected: 16 个用例全 PASS

- [ ] **Step 4: 提交**

```bash
git add README.md docs/superpowers/specs/2026-10-17-daily-token-index-design.md
git commit -m "docs: 同步 README 与设计文档至每日编号行为

README 补编号格式、1000 键 FIFO、单日额度与恢复命令定位；设计文档
修正第 1000 个编号 -1000 的边界表述。

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
