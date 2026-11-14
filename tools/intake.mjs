import { readFile, writeFile, rename, mkdir, mkdtemp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { createSite } from '../src/site.mjs';
import { Journal } from '../src/rpa/journal.mjs';
import { runIntake, buildOutput } from '../src/rpa/collector.mjs';

const usage = `用法：node tools/intake.mjs [--handover 路径] [--out 路径] [--url 门户地址] [--state-dir 目录]
  --handover   交接清单 JSON 数组（默认 data/handover.json）
  --out        结果文件（默认 intake-receipts.json）
  --url        已在运行的门户地址；缺省时启动本地合成门户，结束后关闭
  --state-dir  执行记录目录；连接外部门户时默认 var/intake-state
退出码：0 全部受理；6 有暂停；7 有失败。INTAKE_CRASH_AT 仅用于崩溃恢复演练。`;

const { values: flags } = parseArgs({
  options: {
    handover: { type: 'string', default: 'data/handover.json' },
    out: { type: 'string', default: 'intake-receipts.json' },
    url: { type: 'string' },
    'state-dir': { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
if (flags.help) {
  console.log(usage);
  process.exit(0);
}

let site;
let url = flags.url;
let stateDir = flags['state-dir'];
if (url) {
  stateDir ??= 'var/intake-state';
} else {
  site = await createSite();
  url = site.url;
  // 临时门户没有历史数据，配套全新的执行记录目录，避免误用旧状态。
  stateDir ??= await mkdtemp(join(tmpdir(), 'intake-state-'));
}

const handover = JSON.parse(await readFile(flags.handover, 'utf8'));
if (!Array.isArray(handover)) throw new Error('交接清单必须是 JSON 数组');

console.log(`门户 ${url}`);
console.log(`执行记录目录 ${stateDir}`);
const browser = await chromium.launch({ headless: true });
try {
  const items = await runIntake({
    handover, url, journal: new Journal(stateDir), browser, log: line => console.log(line),
  });
  const output = buildOutput(items, url);
  await mkdir(dirname(flags.out), { recursive: true });
  const temporary = `${flags.out}.tmp`;
  await writeFile(temporary, JSON.stringify(output, null, 2) + '\n');
  await rename(temporary, flags.out);
  const { accepted, review, failed, total } = output.summary;
  console.log(`汇总：受理 ${accepted}，暂停 ${review}，失败 ${failed}（共 ${total}）`);
  for (const item of items.filter(item => item.status !== 'accepted')) {
    console.log(`${item.status === 'review' ? '暂停' : '失败'} ${item.requestKey}：${item.reason}`);
  }
  console.log(`结果已写入 ${flags.out}`);
  process.exitCode = failed > 0 ? 7 : review > 0 ? 6 : 0;
} finally {
  await browser.close();
  await site?.close();
}
