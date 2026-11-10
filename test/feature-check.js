// 追加機能（営業時間外の案内・注文トラブルの受付文・スタッフ通知・リッチメニュー・配送状況の確認）の試験
// LINE・Shopifyには接続せず、偽の送信先で動きを確かめる。
// 使い方: node test/feature-check.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadBot(env = {}) {
  const sent = { replies: [], pushes: [] };
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const sandbox = {
    module: { exports: {} },
    process: { env },
    console: { log() {}, warn() {}, error() {} },
    fetch: () => { throw new Error('試験中は外部に接続しない'); },
    URLSearchParams,
    require: (name) => {
      if (name === '@line/bot-sdk') {
        return {
          messagingApi: {
            MessagingApiClient: function () {
              this.replyMessage = async (m) => sent.replies.push(m);
              this.pushMessage = async (m) => sent.pushes.push(m);
            },
          },
          middleware: () => () => {},
          SignatureValidationFailed: class {},
          JSONParseError: class {},
        };
      }
      if (name === 'express') return () => ({ post() {}, use() {}, listen() {} });
      return require(name);
    },
  };
  vm.runInNewContext(src + '\n;module.exports = { respond, buildReply, planReply, isBusinessHours, parseOrderLookup, parseOrderParts, normalizePhone, describeOrder, trackingLines, handleEvent, orderLookupEnabled };', sandbox);
  return { ...sandbox.module.exports, sent };
}

// 日本時間の日時を作る（例：jst('2026-11-10T11:00')）
const jst = (s) => new Date(s + ':00+09:00');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log('✓ ' + name); } else { fail++; console.log('✗ ' + name + (detail ? '\n   ' + detail : '')); }
}

(async () => {
  const bot = loadBot();
  const NOTE = '営業時間外';

  // --- 営業時間 ---
  check('平日11時は営業時間内', bot.isBusinessHours(jst('2026-11-10T11:00')));
  check('平日9時59分は時間外', !bot.isBusinessHours(jst('2026-11-10T09:59')));
  check('平日19時は時間外', !bot.isBusinessHours(jst('2026-11-10T19:00')));
  check('土曜は時間外', !bot.isBusinessHours(jst('2026-11-14T11:00')));
  check('祝日（11/23 勤労感謝の日）は時間外', !bot.isBusinessHours(jst('2026-11-23T11:00')));
  check('年末（12/30）は時間外', !bot.isBusinessHours(jst('2026-12-30T11:00')));
  check('年始（1/4 月曜）は営業日', bot.isBusinessHours(jst('2027-01-04T11:00')));
  check('サーバーがUTCでも日本時間で判定（UTC 0:30 = 日本 9:30 は時間外）', !bot.isBusinessHours(new Date('2026-11-10T00:30:00Z')));

  // --- 営業時間外の一文 ---
  const offHours = jst('2026-11-14T11:00');
  const onHours = jst('2026-11-10T11:00');
  check('時間外：どれにも当てはまらない質問に一文を添える', bot.buildReply('営業時間は？', offHours).includes(NOTE));
  check('時間内：一文は添えない', !bot.buildReply('営業時間は？', onHours).includes(NOTE));
  check('時間外：健康被害の受付文に一文を添える', bot.buildReply('顔が赤くなりました', offHours).includes(NOTE));
  check('時間外：注文トラブルの受付文に一文を添える', bot.buildReply('商品が届かない', offHours).includes(NOTE));
  check('時間外でも、送料などのFAQには添えない', !bot.buildReply('送料はいくらですか', offHours).includes(NOTE));

  // --- 注文トラブルの受付文 ---
  const trouble = bot.buildReply('箱が潰れていました', onHours);
  check('注文トラブル：注文番号・お名前・写真をお願いする', ['ご注文番号', 'お名前', '写真'].every((w) => trouble.includes(w)), trouble);
  check('Shopify未設定なら、配送状況の自動確認は案内しない', !trouble.includes('自動でお調べ'));

  // --- リッチメニュー ---
  const menu = {
    '送料・お届けについて': ['menu_shipping', ['1,000円', '5営業日']],
    'お支払い方法について': ['menu_payment', ['クレジットカード']],
    '送料・お支払いについて': ['menu_shipping_payment', ['1,000円', '5営業日', 'クレジットカード', '銀行振込']],
    '返品・交換について': ['menu_return', ['7日以内', '写真']],
    '専売品の購入方法': ['menu_password', ['カウンセリング']],
    'ご注文状況の確認': ['menu_order_status', ['ご注文番号']],
    'その他のお問い合わせ': ['menu_contact', ['お問い合わせ内容']],
  };
  for (const [label, [type, words]] of Object.entries(menu)) {
    const r = bot.planReply(label);
    check(`メニュー「${label}」→ ${type}`, r.type === type && words.every((w) => r.text.includes(w)), `${r.type}: ${r.text}`);
  }
  check('メニュー文言の前後に空白があっても同じ返信', bot.planReply(' 返品・交換について ').type === 'menu_return');
  check('「その他のお問い合わせ」はスタッフ対応扱い', bot.planReply('その他のお問い合わせ').staff === true);

  // --- 注文番号・連絡先の読み取り ---
  const p = (t) => JSON.stringify(bot.parseOrderLookup(t));
  check('#1001 とメールを読み取る', p('#1001 Taro@Example.com') === JSON.stringify({ orderNumber: '1001', email: 'taro@example.com', phone: null }));
  check('1001 と電話番号を読み取る', p('1001 090-1234-5678') === JSON.stringify({ orderNumber: '1001', email: null, phone: '09012345678' }));
  check('全角の＃１００１と電話番号を読み取る', p('注文番号は＃１００１、電話は０９０１２３４５６７８です') === JSON.stringify({ orderNumber: '1001', email: null, phone: '09012345678' }));
  check('+81 の電話番号を国内の形にそろえる', bot.normalizePhone('+81 90-1234-5678') === '09012345678');
  check('注文番号だけでは確認しない', bot.parseOrderLookup('#1001 はいつ届きますか') === null);
  check('メールアドレスだけでは確認しない', bot.parseOrderLookup('taro@example.com') === null);
  check('電話番号だけでは確認しない（電話番号の一部を注文番号と取り違えない）', bot.parseOrderLookup('09012345678') === null);

  // --- 配送状況の確認（偽のShopify） ---
  const orders = {
    1001: { name: '#1001', email: 'Taro@Example.com', phone: null, cancelledAt: null, displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'FULFILLED',
      shippingAddress: { phone: '+81 90-1234-5678' }, fulfillments: [{ status: 'SUCCESS', trackingInfo: [{ company: 'ヤマト運輸', number: '1234-5678-9012', url: 'https://example.com/track' }] }] },
    1002: { name: '#1002', email: 'hanako@example.com', phone: null, cancelledAt: null, displayFinancialStatus: 'PENDING', displayFulfillmentStatus: 'UNFULFILLED', shippingAddress: null, fulfillments: [] },
    1003: { name: '#1003', email: 'jiro@example.com', phone: null, cancelledAt: '2026-11-01T00:00:00Z', displayFinancialStatus: 'REFUNDED', displayFulfillmentStatus: 'UNFULFILLED', shippingAddress: null, fulfillments: [] },
  };
  const findOrder = async (n) => orders[n] || null;
  let uid = 0;
  const ask = (text, extra = {}) => bot.respond(text, { now: onHours, userId: 'U' + (++uid), findOrder, ...extra });

  let r = await ask('#1001 taro@example.com');
  check('メール一致：発送済みと追跡番号を返す', r.type === 'order_lookup' && r.text.includes('発送済み') && r.text.includes('1234-5678-9012'), r.text);
  r = await ask('1001 09012345678');
  check('配送先の電話番号でも一致とみなす', r.type === 'order_lookup', r.text);
  r = await ask('#1001 someone@example.com');
  check('メール不一致：見つからないと返す（注文の中身は出さない）', r.type === 'order_lookup_not_found' && !r.text.includes('1234-5678-9012'), r.text);
  r = await ask('#9999 taro@example.com');
  check('存在しない注文：不一致と同じ返信', r.type === 'order_lookup_not_found');
  r = await ask('#1002 hanako@example.com');
  check('銀行振込の入金待ち：お振込み確認待ちと返す', r.text.includes('お振込みの確認待ち') && r.text.includes('お振込みの確認後'), r.text);
  r = await ask('#1003 jiro@example.com');
  check('キャンセル済みの注文', r.text.includes('キャンセル済み'), r.text);
  r = await ask('#1001 taro@example.com 届いた箱が潰れていました');
  check('注文トラブル＋注文番号：状況を返し、スタッフ対応にも回す', r.text.includes('発送済み') && r.text.includes('担当スタッフ') && r.staff === true, r.text);
  r = await ask('#1001 taro@example.com 使ったら赤くなりました');
  check('健康被害が含まれていれば、注文確認より健康被害を優先', r.type === 'adverse_event' && r.notify === true, r.type);
  r = await bot.respond('#1001 taro@example.com', { now: onHours, userId: 'Ux', findOrder: async () => { throw new Error('down'); } });
  check('Shopifyに接続できないとき：スタッフ対応に回す', r.type === 'order_lookup_error' && r.staff === true);

  // --- 表記揺れ（どれも #1001 と同じ連絡先として読み取れること） ---
  const same = (t, email, phone) => {
    const r = bot.parseOrderLookup(t);
    return r && r.orderNumber === '1001' && r.email === (email || null) && r.phone === (phone || null);
  };
  const E = 'taro@example.com', P = '09012345678';
  for (const [t, e, ph] of [
    ['＃１００１　ｔａｒｏ＠ｅｘａｍｐｌｅ．ｃｏｍ', E], ['#1001　taro@example.com', E], ['#1001 taro@example.comです', E],
    ['注文番号は1001です。メールはtaro@example.comです', E], ['1001番 taro@example.com', E], ['No.1001 taro@example.com', E],
    ['#1001taro@example.com', E], ['taro@example.com #1001', E], ['#1001\ntaro@example.com', E], ['# 1001 Taro@Example.COM', E],
    ['注文番号：1001 メールアドレス：taro@example.com よろしくお願いします。', E],
    ['注文#1001、電話090-1234-5678', null, P], ['#1001 090ー1234ー5678', null, P], ['#1001 ０９０－１２３４－５６７８', null, P],
    ['#1001 090 1234 5678', null, P], ['#1001 +81 90 1234 5678', null, P], ['#1001 電話は09012345678です', null, P],
    ['#1001 09012345678', null, P], ['#1001　０９０１２３４５６７８', null, P], ['1001 09012345678', null, P],
    ['#1001\n09012345678', null, P], ['#1001、09012345678', null, P], ['#1001 +819012345678', null, P],
    ['#100109012345678', null, P], ['＃１００１０９０１２３４５６７８', null, P],
    ['#1001 0368995322', null, '0368995322'],
  ]) check(`表記揺れ「${t.replace('\n', '↵')}」`, same(t, e, ph), JSON.stringify(bot.parseOrderLookup(t)));

  // --- 2回に分けて送る ---
  let two = await bot.respond('#1001', { now: onHours, userId: 'Utwo', findOrder });
  check('「#1001」だけ：メールアドレスか電話番号をお願いする', two.type === 'order_need_contact' && two.text.includes('#1001') && two.text.includes('メールアドレスまたは電話番号'), two.text);
  two = await bot.respond('taro@example.com', { now: new Date(onHours.getTime() + 60000), userId: 'Utwo', findOrder });
  check('続けてメールアドレスだけ：覚えておいた #1001 で調べる', two.type === 'order_lookup' && two.text.includes('#1001'), two.text);
  two = await bot.respond('taro@example.com', { now: new Date(onHours.getTime() + 120000), userId: 'Utwo', findOrder });
  check('調べ終えたら番号は忘れる（次のメールアドレスだけには番号をお願いする）', two.type === 'order_need_number', two.text);
  await bot.respond('注文番号は1001です', { now: onHours, userId: 'Uphone', findOrder });
  two = await bot.respond('090-1234-5678', { now: new Date(onHours.getTime() + 60000), userId: 'Uphone', findOrder });
  check('「注文番号は1001です」→電話番号だけ：調べる', two.type === 'order_lookup', two.text);
  await bot.respond('#1001', { now: onHours, userId: 'Uphone2', findOrder });
  two = await bot.respond('０９０１２３４５６７８', { now: new Date(onHours.getTime() + 60000), userId: 'Uphone2', findOrder });
  check('「#1001」→全角で続けて書いた電話番号だけ：調べる', two.type === 'order_lookup', two.text);
  await bot.respond('#1001', { now: onHours, userId: 'Uold', findOrder });
  two = await bot.respond('taro@example.com', { now: new Date(onHours.getTime() + 16 * 60000), userId: 'Uold', findOrder });
  check('15分を過ぎたら番号は使わない', two.type === 'order_need_number', two.type);
  await bot.respond('#1001', { now: onHours, userId: 'Uother1', findOrder });
  two = await bot.respond('taro@example.com', { now: onHours, userId: 'Uother2', findOrder });
  check('別の人が送った番号は使わない', two.type === 'order_need_number', two.type);
  two = await bot.respond('#1001 届かないです', { now: onHours, userId: 'Utr', findOrder });
  check('「#1001 届かない」：受付文に連絡先のお願いを添える（スタッフ対応のまま）', two.type === 'order_trouble' && two.staff && two.text.includes('ご注文 #1001 の配送状況をお調べします'), two.text);
  check('金額（15000円）を注文番号と取り違えない', (await bot.respond('15000円以上で送料無料ですか', { now: onHours, userId: 'Uyen', findOrder })).type === 'faq_shipping');
  check('数字だけ「1001」も注文番号とみなす', (await bot.respond('1001', { now: onHours, userId: 'Unum', findOrder })).type === 'order_need_contact');

  // --- 追跡ページ ---
  const tl = (company, number, url) => bot.trackingLines({ company, number, url }).join('\n');
  let x = tl('Yamato (JA)', '1234-5678-9012');
  check('Yamato (JA)：「ヤマト運輸」と表示し、追跡ページを組み立てる', x.includes('配送会社：ヤマト運輸') && x.includes('crjz.b.NQ0010?id=123456789012'), x);
  x = tl('Sagawa (JA)', '123456789012');
  check('Sagawa (JA)：「佐川急便」と追跡ページ', x.includes('配送会社：佐川急便') && x.includes('okurijoNo=123456789012'), x);
  x = tl('Japan Post (JA)', 'AB123456789JP');
  check('Japan Post (JA)：「日本郵便」と追跡ページ（英字入りの番号もそのまま）', x.includes('配送会社：日本郵便') && x.includes('reqCodeNo1=AB123456789JP'), x);
  x = tl('ゆうパケット', '１２３４５６７８９０１２');
  check('ゆうパケット・全角の番号：日本郵便として半角の番号で組み立てる', x.includes('日本郵便') && x.includes('reqCodeNo1=123456789012'), x);
  x = tl('Yamato (JA)', '123456789012', 'https://example.com/track/1');
  check('Shopify側に追跡URLがあれば、そちらを優先する', x.includes('https://example.com/track/1') && !x.includes('kuronekoyamato'), x);
  x = tl('西濃運輸', '123456789012');
  check('知らない配送会社：社名はそのまま、URLは付けない', x.includes('配送会社：西濃運輸') && !x.includes('配送状況'), x);
  x = tl('', '123456789012');
  check('配送会社が空：「－」と表示し、URLは付けない', x.includes('配送会社：－') && !x.includes('配送状況'), x);

  // 同じ人からの確認は10分に5回まで
  const many = [];
  for (let i = 0; i < 6; i++) many.push(await bot.respond('#9999 a@example.com', { now: onHours, userId: 'Ulimit', findOrder }));
  check('同じ人の6回目の確認は止める', many[4].type === 'order_lookup_not_found' && many[5].type === 'order_lookup_limited');
  const later = await bot.respond('#9999 a@example.com', { now: new Date(onHours.getTime() + 11 * 60 * 1000), userId: 'Ulimit', findOrder });
  check('10分たてば再び確認できる', later.type === 'order_lookup_not_found');

  // --- LINEとのやり取り（偽のLINE） ---
  const notifyBot = loadBot({ STAFF_NOTIFY_TO: 'Cstaffgroup' });
  const ev = (text, source = { type: 'user', userId: 'Ucustomer' }) => ({ type: 'message', replyToken: 'rt', source, message: { type: 'text', text } });

  await notifyBot.handleEvent(ev('顔が赤くなりました'));
  check('健康被害：お客様に受付文を返す', notifyBot.sent.replies.length === 1 && notifyBot.sent.replies[0].messages[0].text.includes('担当スタッフ'));
  const push = notifyBot.sent.pushes[0];
  check('健康被害：スタッフのグループに通知する', push && push.to === 'Cstaffgroup' && push.messages[0].text.includes('健康被害'));
  check('通知にはお客様のメッセージ本文を載せない', push && !push.messages[0].text.includes('赤くなりました'));

  await notifyBot.handleEvent(ev('送料はいくらですか'));
  check('健康被害以外では通知しない', notifyBot.sent.pushes.length === 1);

  const before = notifyBot.sent.replies.length;
  await notifyBot.handleEvent(ev('今日のシフトどうする？', { type: 'group', groupId: 'Cstaffgroup', userId: 'Ustaff' }));
  check('スタッフのグループ内の会話には返信しない', notifyBot.sent.replies.length === before);

  await notifyBot.handleEvent({ type: 'join', replyToken: 'rt2', source: { type: 'group', groupId: 'Cnewgroup' } });
  const joinReply = notifyBot.sent.replies[notifyBot.sent.replies.length - 1].messages[0].text;
  check('グループに招待されたら、通知先に設定するIDを知らせる', joinReply.includes('Cnewgroup') && joinReply.includes('STAFF_NOTIFY_TO'));

  const silentBot = loadBot();
  await silentBot.handleEvent(ev('顔が赤くなりました'));
  check('STAFF_NOTIFY_TO が未設定なら通知しない（返信はする）', silentBot.sent.pushes.length === 0 && silentBot.sent.replies.length === 1);

  // Shopifyの設定があるときは、案内文に自動確認の説明が入る
  const shopBot = loadBot({ SHOPIFY_SHOP: 'example', SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'secret' });
  check('Shopify設定あり：注文トラブルの受付文に自動確認の案内', shopBot.buildReply('商品が届かない', onHours).includes('自動でお調べ'));
  check('Shopify設定あり：メニュー「ご注文状況の確認」は自動確認の案内', shopBot.planReply('ご注文状況の確認').text.includes('#1001'));

  console.log(`\n合格 ${pass} / ${pass + fail}`);
  process.exitCode = fail ? 1 : 0;
})();
