// 特定商取引法に基づく表記。波括弧 2 重括り (例: EMAIL, DOMAIN 等) は
// docs/legal-placeholders.md の sed 置換対象。
// 個人事業主運営前提: 氏名・住所・電話番号は「ご請求があった場合は遅滞なく開示」を採用。

export const metadata = {
  title: '特定商取引法に基づく表記',
  description: '特定商取引法第 11 条に基づく表記のページです。',
}

export default function CommerceDisclosurePage() {
  return (
    <article className="max-w-3xl mx-auto w-full px-4 py-8 md:py-12 space-y-6">
      <h1 className="text-2xl font-bold text-slate-900">特定商取引法に基づく表記</h1>

      <p className="text-sm text-slate-700 leading-relaxed bg-slate-100 border border-slate-200 rounded-md p-4">
        個人事業主による運営のため、特定商取引法に基づき、販売事業者の氏名・住所・電話番号は、消費者からのご請求に応じて遅滞なく開示いたします。ご請求は <span className="font-medium">{'{{EMAIL}}'}</span> までお願いいたします。
      </p>

      <dl className="text-sm text-slate-700 space-y-3">
        <Item term="販売事業者" desc="ご請求があった場合は遅滞なく開示します" />
        <Item term="運営責任者" desc="ご請求があった場合は遅滞なく開示します" />
        <Item term="所在地" desc="ご請求があった場合は遅滞なく開示します" />
        <Item term="電話番号" desc="ご請求があった場合は遅滞なく開示します (お問い合わせは原則メールにて承ります)" />
        <Item term="メールアドレス" desc={'{{EMAIL}}'} />
        <Item
          term="受付時間"
          desc={
            <>
              メールにて随時受付いたします。
              <br />
              営業時間: {'{{BUSINESS_HOURS}}'} (土日祝・年末年始を除く)
            </>
          }
        />
        <Item
          term="ホームページ URL"
          desc={
            <>
              <span className="break-all">https://{'{{DOMAIN}}'}</span>
            </>
          }
        />
        <Item
          term="販売価格"
          desc={
            <>
              各料金プランページに表示しております。本サービスの有料プランは {'{{PRICE}}'} (税込・月額) です。
            </>
          }
        />
        <Item term="商品代金以外の必要料金" desc="なし (インターネット接続料金、通信料金等は利用者のご負担となります)" />
        <Item term="引渡時期" desc="お申込みおよび決済完了後、直ちに本サービスをご利用いただけます。" />
        <Item term="支払方法" desc="クレジットカード (Stripe, Inc. が運営する決済代行サービスを介します)" />
        <Item
          term="支払時期"
          desc="お申込み時に初回課金、以降は毎月の更新日に自動課金とします。"
        />
        <Item
          term="返品・キャンセル等 (返品特約)"
          desc={
            <>
              本サービスはデジタルコンテンツの提供および継続的役務提供に該当します。サービス開始後の返金・返品は、当社の責めに帰すべき事由がある場合を除き、原則として承っておりません。
              <br />
              サブスクリプションの解約は、次回更新日の前日までに利用者ご自身でお手続きいただくことで、次回更新を停止できます。解約手続後、現在の課金期間の終了日までは引き続き本サービスをご利用いただけます。
            </>
          }
        />
        <Item term="動作環境" desc="モダンブラウザ (Chrome / Safari / Edge / Firefox の最新版)" />
      </dl>

      <hr className="border-slate-200 my-8" />

      <p className="text-xs text-slate-500">{'{{LAST_UPDATED}}'} 制定</p>
    </article>
  )
}

function Item({
  term,
  desc,
}: {
  term: string
  desc: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-[180px_1fr] gap-1 md:gap-4 py-2 border-b border-slate-100">
      <dt className="font-medium text-slate-900">{term}</dt>
      <dd className="text-slate-700 leading-relaxed">{desc}</dd>
    </div>
  )
}
