// LINEボットの応答判定テスト（LINEに接続せず、メッセージ→分類を検証する）
// 使い方: node line-bot/test/run-tests.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// index.js をLINE・Express抜きで読み込み、buildReply / matchRule を取り出す
function loadBot() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const fakeApp = { post() {}, use() {}, listen() {} };
  const sandbox = {
    module: { exports: {} },
    process: { env: {} },
    console,
    require: (name) => {
      if (name === '@line/bot-sdk') return { messagingApi: { MessagingApiClient: function () {} }, middleware: () => () => {} };
      if (name === 'express') return () => fakeApp;
      return require(name);
    },
  };
  vm.runInNewContext(src + '\n;module.exports = { matchRule, buildReply, FALLBACK_MESSAGE };', sandbox);
  return sandbox.module.exports;
}

const { matchRule, buildReply } = loadBot();
const file = process.argv[2] || 'cases.json';
const cases = require('./' + file);
console.log('テストセット: ' + file);

let pass = 0;
const fails = [];
for (const c of cases) {
  const rule = matchRule(c.text);
  const got = rule ? rule.type : 'fallback';
  if (got === c.expect) pass++;
  else fails.push({ ...c, got, reply: buildReply(c.text) });
}

console.log(`正解 ${pass}/${cases.length}（${Math.round((pass / cases.length) * 100)}%）\n`);
for (const f of fails) {
  console.log(`✗ 「${f.text}」\n   期待: ${f.expect} / 実際: ${f.got}\n   返信: ${f.reply.replace(/\n/g, ' ')}\n`);
}
process.exitCode = fails.length ? 1 : 0;
