// シミクレール LINE公式アカウント 自動応答ボット
//
// 設計方針（戦略レポートより）:
//   1. 一般的なFAQ（送料・使い方・定期便等）→ 固定回答で即答
//   2. 効能・診断的な質問（ニキビに効く？等）→ 個人差がある旨の定型文で必ずかわす（AIに自由回答させない）
//   3. 健康被害の申告（かぶれ・赤み等）→ 自動返信はせず、スタッフが直接目視できるよう保留する
//   4. 注文トラブル（未着・破損等）→ 同上、スタッフ対応に回す
//   5. 上記いずれにも一致しない場合のみ、簡易なフォールバック文を返す
//
// 医師・看護師へのエスカレーション経路は意図的に作っていない（05章の設計に準拠）。
// 3・4は「自動返信しない」ことで、LINE公式アカウントマネージャーの受信箱を
// スタッフが定期的に確認し、そこから直接返信する運用を想定している。

const line = require('@line/bot-sdk');
const express = require('express');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

const app = express();

// ---------------------------------------------------------------------------
// ルール定義
// 上から順に判定し、最初に一致したルールを採用する。
// ---------------------------------------------------------------------------

const HOLD_MESSAGE =
  'お問い合わせありがとうございます。担当スタッフより確認のうえ、順次ご連絡いたします。';

const EFFICACY_TEMPLATE =
  '製品の効果には個人差があり、特定の症状に効くかどうかについては断定的にお答えできません。\n' +
  '一般的な製品特徴は各商品ページをご確認ください。気になる症状がある場合は、お近くの皮膚科の受診をご検討ください。';

const rules = [
  // --- 3. 健康被害の申告：自動返信せず保留（最優先で判定） ---
  {
    type: 'adverse_event',
    keywords: ['かぶれ', '赤み', '腫れ', 'かゆみ', 'アレルギー', '湿疹', '痛み', '炎症'],
    handle: () => HOLD_MESSAGE,
  },

  // --- 4. 注文トラブル：自動返信せず保留 ---
  {
    type: 'order_trouble',
    keywords: ['届かない', '未着', '破損', '間違い', '誤配送', '返金', 'キャンセル', '不良品'],
    handle: () => HOLD_MESSAGE,
  },

  // --- 2. 効能・診断的な質問：定型文でかわす ---
  {
    type: 'efficacy_question',
    keywords: ['効きます', '効果ある', '治り', '治す', 'ニキビ', 'シミ', '合います', '合うか'],
    handle: () => EFFICACY_TEMPLATE,
  },

  // --- 1. FAQ：固定回答 ---
  {
    type: 'faq_shipping',
    keywords: ['送料', '配送料', '送り方'],
    handle: () =>
      '送料は全国一律770円です。合計15,000円以上のご購入で送料無料になります。ご注文から7日以内に発送いたします。',
  },
  {
    type: 'faq_delivery_time',
    keywords: ['何日', '届く', '発送まで', 'いつ届'],
    handle: () => 'ご注文を受けてから7日以内に発送いたします（要診療の商品を除く）。',
  },
  {
    type: 'faq_payment',
    keywords: ['支払い方法', '支払方法', 'カード払い', '代引き'],
    handle: () =>
      'クレジットカード、代金引換、銀行振込、後払い決済、PayPayがご利用いただけます。',
  },
  {
    type: 'faq_subscription',
    keywords: ['定期便', '休止', '解約', 'スキップ', '定期購入'],
    handle: () =>
      '定期便の休止・解約はマイページからいつでも手続きいただけます。次回お届け予定日の7日前までにご変更ください。',
  },
  {
    type: 'faq_return',
    keywords: ['返品', '交換'],
    handle: () => '商品到着後8日以内（未開封・未使用に限る）であれば返品を承っております。',
  },
  {
    type: 'faq_howto',
    keywords: ['使い方', '使用方法', '塗り方', '順番'],
    handle: () =>
      '基本的な使用順序は「洗顔 → 化粧水 → 美容液 → クリーム → 日焼け止め」です。各商品ページにも使用方法を記載していますのでご確認ください。',
  },
];

// キーワード一致でルールを判定する。
function matchRule(text) {
  for (const rule of rules) {
    if (rule.keywords.some((kw) => text.includes(kw))) {
      return rule;
    }
  }
  return null;
}

const FALLBACK_MESSAGE =
  'お問い合わせありがとうございます。内容を確認し、担当スタッフより順次ご連絡いたします。お急ぎの場合はお時間をいただく場合がございます。';

function buildReply(userText) {
  const rule = matchRule(userText);
  if (!rule) {
    return FALLBACK_MESSAGE;
  }
  return rule.handle(userText);
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return;
  }

  const replyText = buildReply(event.message.text);

  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: 'text', text: replyText }],
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`シミクレール LINEボット起動：ポート ${PORT}`);
});
