// 返信の中身が今のストア設定と合っているかを確認する（数字の書き換え漏れ防止）
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const sb = { module: { exports: {} }, process: { env: {} }, console,
  require: (n) => n === '@line/bot-sdk' ? { messagingApi: { MessagingApiClient: function () {} }, middleware: () => () => {} }
    : n === 'express' ? () => ({ get() {}, post() {}, use() {}, listen() {} }) : require(n) };
vm.runInNewContext(src + '\n;module.exports={buildReply};', sb);
const { buildReply } = sb.module.exports;

const checks = [
  ['送料はいくらですか', ['1,000円', '15,000円'], ['770']],
  ['発送はいつですか', ['5営業日'], ['7日以内に発送']],
  ['支払い方法は？', ['クレジットカード', 'Apple Pay', 'Google Pay', 'Shop Pay', '銀行振込', '7日以内'], []],
  ['返品できますか', ['7日以内', '不良', 'お受けしておりません', 'ご注文番号', '写真'], ['8日以内', '未開封']],
  ['定期便はありますか', ['お取り扱いはございません'], ['マイページ']],
  ['パスワードを教えて', ['ゼオスキン', 'カウンセリングを受けた方', '購入パスワードはカート画面'], ['カイゲン', 'ワカサプリ', '医師', '診察']],
  ['診察を受けたいです', ['カウンセリング', '購入パスワード'], ['医師', '診察']],
  ['パスワードを教えて', ['カウンセリング前に購入する', '14日以内', 'ご注文番号', '全額返金', '3.6%＋500円', '銀行振込はご利用いただけません', 'カウンセリング予約'], ['5%（最低550円）']],
  ['カウンセリングを予約したい', ['対面カウンセリング（いしだ皮フ科・美容皮膚科）', 'オンラインカウンセリング', 'ご注文番号', '10分程度', '次の枠をご予約'], ['医師', '診察']],
  ['オンラインカウンセリング', ['①ご注文番号', '②ご希望の日時を3つ', '③お名前', 'LINEのビデオ通話', '10分程度', 'LINEアプリを最新版', '明るい場所', '正面から顔が映る', '通話リクエスト', '直接お電話をおかけすることはできません'], ['医師', '診察']],
  ['支払い方法を教えて', ['クレジットカード', '銀行振込', 'カウンセリング前に購入する場合は、銀行振込はご利用いただけません'], []],
  ['ニキビに効きますか', ['個人差', '医療機関にご相談ください'], ['医師', '診察']],
  ['専売品の購入方法', ['ゼオスキン', 'カート画面'], ['カイゲン', 'ワカサプリ', '医師', '診察']],
];
let ng = 0;
for (const [q, must, mustNot] of checks) {
  const r = buildReply(q);
  const miss = must.filter((m) => !r.includes(m));
  const bad = mustNot.filter((m) => r.includes(m));
  if (miss.length || bad.length) { ng++; console.log(`✗ 「${q}」 不足:${miss.join('/')} 誤り:${bad.join('/')}\n   ${r}`); }
  else console.log(`✓ 「${q}」`);
}
process.exitCode = ng ? 1 : 0;
