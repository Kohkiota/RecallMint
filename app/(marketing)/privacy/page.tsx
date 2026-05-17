// プライバシーポリシー。波括弧 2 重括り (例: {{COMPANY_NAME}}, {{EMAIL}} 等
// の 12 placeholder) は docs/legal-placeholders.md の sed 置換対象。
// SERVICE_NAME は 2026-05-17 placeholder 撤回、 RecallMint hardcode に統一。

export const metadata = {
  title: 'プライバシーポリシー',
  description: '本サービスにおける個人情報の取扱いについてのプライバシーポリシーのページです。',
}

export default function PrivacyPage() {
  return (
    <article className="max-w-3xl mx-auto w-full px-4 py-8 md:py-12 space-y-6">
      <h1 className="text-2xl font-bold text-slate-900">プライバシーポリシー</h1>

      <p className="text-sm text-slate-700 leading-relaxed">
        {'{{COMPANY_NAME}}'} (以下「当社」といいます) は、当社が提供する RecallMint (以下「本サービス」といいます) における利用者の個人情報の取扱いについて、以下のとおりプライバシーポリシー (以下「本ポリシー」といいます) を定めます。
      </p>

      <Section title="第1条 (基本方針)">
        <p className="text-sm text-slate-700 leading-relaxed">
          当社は、個人情報の保護に関する法律 (平成 15 年法律第 57 号、以下「個人情報保護法」といいます) およびその他関連する法令、ガイドラインを遵守し、利用者の個人情報を適正に取り扱います。
        </p>
      </Section>

      <Section title="第2条 (取得する個人情報の項目)">
        <p className="text-sm text-slate-700 mb-2">当社は、本サービスの利用者から以下の個人情報を取得します。</p>
        <ol className="list-decimal list-inside space-y-1 text-sm text-slate-700">
          <li>氏名およびメールアドレス (Clerk アカウント作成時に Clerk 経由で取得)</li>
          <li>認証情報 (パスワード等は Clerk が直接処理し、当社サーバーには保存されません)</li>
          <li>決済情報 (クレジットカード番号等は Stripe が直接処理し、当社は Stripe Customer ID 等の参照情報のみを保有します)</li>
          <li>学習データ (語彙登録、復習履歴、FSRS スケジュール、AI 例文生成履歴など、本サービスの利用に伴い生成される情報)</li>
          <li>Cookie、アクセスログ、IP アドレス、ブラウザ情報、利用日時等の技術情報</li>
        </ol>
      </Section>

      <Section title="第3条 (利用目的)">
        <p className="text-sm text-slate-700 mb-2">当社は、取得した個人情報を以下の目的で利用します。</p>
        <ol className="list-decimal list-inside space-y-1 text-sm text-slate-700">
          <li>本サービスの提供および運営のため</li>
          <li>利用者の本人認証および本人確認のため</li>
          <li>利用料金の課金、決済、請求のため</li>
          <li>学習データの保存および分析機能 (復習スケジューリング等) の提供のため</li>
          <li>利用者からのお問い合わせに対する回答およびサポート対応のため</li>
          <li>不正利用、規約違反、セキュリティインシデント等の検知および防止のため</li>
          <li>個人を特定しない形での統計データを作成し、本サービスの改善および新機能の開発に役立てるため</li>
          <li>本サービスに関する重要なお知らせ (利用規約の変更、メンテナンス予定、セキュリティに関する通知等) を通知するため</li>
        </ol>
      </Section>

      <Section title="第4条 (第三者提供)">
        <p className="text-sm text-slate-700 leading-relaxed mb-2">
          当社は、利用者の個人情報を、利用者の同意を得ずに第三者に提供することはありません。ただし、以下のいずれかに該当する場合は、この限りではありません。
        </p>
        <ol className="list-decimal list-inside space-y-1 text-sm text-slate-700">
          <li>法令に基づく場合</li>
          <li>人の生命、身体または財産の保護のために必要がある場合であって、利用者の同意を得ることが困難であるとき</li>
          <li>公衆衛生の向上または児童の健全な育成の推進のために特に必要がある場合であって、利用者の同意を得ることが困難であるとき</li>
          <li>国の機関もしくは地方公共団体またはその委託を受けた者が法令の定める事務を遂行することに対して協力する必要がある場合であって、利用者の同意を得ることにより当該事務の遂行に支障を及ぼすおそれがあるとき</li>
        </ol>
      </Section>

      <Section title="第5条 (個人データの取扱いの委託)">
        <p className="text-sm text-slate-700 leading-relaxed mb-3">
          当社は、利用目的の達成に必要な範囲内において、個人データの取扱いの全部または一部を以下の事業者に委託しています。当社は、委託先における個人データの安全管理が図られるよう、委託先に対する必要かつ適切な監督を行います。
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-slate-700 border border-slate-200">
            <thead className="bg-slate-100">
              <tr>
                <th className="text-left px-3 py-2 border-b border-slate-200 font-medium">委託先</th>
                <th className="text-left px-3 py-2 border-b border-slate-200 font-medium">委託業務</th>
                <th className="text-left px-3 py-2 border-b border-slate-200 font-medium">所在国</th>
              </tr>
            </thead>
            <tbody>
              <tr><td className="px-3 py-2 border-b border-slate-200">Clerk, Inc.</td><td className="px-3 py-2 border-b border-slate-200">利用者認証基盤の提供</td><td className="px-3 py-2 border-b border-slate-200">米国</td></tr>
              <tr><td className="px-3 py-2 border-b border-slate-200">Stripe, Inc.</td><td className="px-3 py-2 border-b border-slate-200">決済処理</td><td className="px-3 py-2 border-b border-slate-200">米国</td></tr>
              <tr><td className="px-3 py-2 border-b border-slate-200">Neon, Inc.</td><td className="px-3 py-2 border-b border-slate-200">データベースのホスティング</td><td className="px-3 py-2 border-b border-slate-200">米国</td></tr>
              <tr><td className="px-3 py-2 border-b border-slate-200">Vercel, Inc.</td><td className="px-3 py-2 border-b border-slate-200">アプリケーションのホスティング</td><td className="px-3 py-2 border-b border-slate-200">米国</td></tr>
              <tr><td className="px-3 py-2">Google LLC</td><td className="px-3 py-2">AI による例文生成 API の提供</td><td className="px-3 py-2">米国</td></tr>
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="第6条 (外国にある第三者への個人データの提供)">
        <ol className="list-decimal list-inside space-y-2 text-sm text-slate-700">
          <li>前条に記載のとおり、当社は個人データの取扱いを米国に所在する事業者に委託しており、これに伴い、利用者の個人データは米国に移転されることがあります。</li>
          <li>各委託先のプライバシーポリシーは以下より参照できます。
            <ul className="list-disc list-inside ml-4 mt-1 space-y-1 text-sm break-all">
              <li>Clerk: <a href="https://clerk.com/legal/privacy" className="text-blue-700 hover:underline" rel="noopener noreferrer" target="_blank">https://clerk.com/legal/privacy</a></li>
              <li>Stripe: <a href="https://stripe.com/jp/privacy" className="text-blue-700 hover:underline" rel="noopener noreferrer" target="_blank">https://stripe.com/jp/privacy</a></li>
              <li>Neon: <a href="https://neon.com/privacy-policy" className="text-blue-700 hover:underline" rel="noopener noreferrer" target="_blank">https://neon.com/privacy-policy</a></li>
              <li>Vercel: <a href="https://vercel.com/legal/privacy-policy" className="text-blue-700 hover:underline" rel="noopener noreferrer" target="_blank">https://vercel.com/legal/privacy-policy</a></li>
              <li>Google: <a href="https://policies.google.com/privacy" className="text-blue-700 hover:underline" rel="noopener noreferrer" target="_blank">https://policies.google.com/privacy</a></li>
            </ul>
          </li>
          <li>各委託先は、自社のプライバシーポリシーおよびデータ処理契約 (DPA) を通じて、個人情報の保護のために適切な措置を講じています。</li>
        </ol>
      </Section>

      <Section title="第7条 (安全管理措置および外的環境の把握)">
        <ol className="list-decimal list-inside space-y-2 text-sm text-slate-700">
          <li>当社は、取扱う個人データの漏えい、滅失または毀損の防止その他の個人データの安全管理のため、組織的・人的・物理的・技術的安全管理措置を講じています。当社は小規模事業者であり、利用するクラウドサービス各社のセキュリティ機能および認証 (SOC 2 Type II 等) に依拠する形で安全管理を実施しています。</li>
          <li>米国においては、連邦レベルでの包括的な個人情報保護法は存在せず、州法 (カリフォルニア州消費者プライバシー法 (CCPA) 等) およびセクター別の連邦法 (HIPAA、GLBA 等) によって規律されています。当社は、委託先各社のデータ処理契約および各社のセキュリティ認証に基づき、日本の個人情報保護法に相当する措置が継続的に講じられていることを確認しています。</li>
        </ol>
      </Section>

      <Section title="第8条 (Cookie その他の技術)">
        <p className="text-sm text-slate-700 leading-relaxed mb-2">
          本サービスでは、利用者の利便性向上およびサービス運営のために、Cookie および類似の技術を使用しています。
        </p>
        <ol className="list-decimal list-inside space-y-1 text-sm text-slate-700">
          <li>認証 Cookie: Clerk が発行する認証 Cookie によりログイン状態を保持します。</li>
          <li>決済関連 Cookie: Stripe が決済画面において不正検知等のために使用する Cookie です。</li>
          <li>セッション Cookie: 本サービスのセッション維持のため当社が使用する Cookie です。</li>
        </ol>
        <p className="text-sm text-slate-700 leading-relaxed mt-2">
          利用者はブラウザ設定により Cookie の受け取りを拒否することができますが、その場合、本サービスの一部機能が利用できなくなることがあります。
        </p>
      </Section>

      <Section title="第9条 (開示・訂正・利用停止等の請求)">
        <ol className="list-decimal list-inside space-y-2 text-sm text-slate-700">
          <li>利用者は、当社が保有する自己の個人情報について、個人情報保護法に基づき、開示、訂正、追加、削除、利用停止、消去、第三者への提供の停止、第三者提供記録の開示を請求することができます。</li>
          <li>前項の請求は、以下の窓口宛にメールにてお願いいたします。
            <ul className="list-disc list-inside ml-4 mt-1">
              <li>連絡先: {'{{EMAIL}}'}</li>
            </ul>
          </li>
          <li>請求にあたっては、利用者本人であることを確認するため、当社が指定する方法による本人確認手続にご協力ください。</li>
          <li>開示請求の手数料は {'{{DISCLOSURE_FEE}}'} とします。</li>
        </ol>
      </Section>

      <Section title="第10条 (プライバシーポリシーの変更)">
        <p className="text-sm text-slate-700 leading-relaxed">
          当社は、必要に応じて本ポリシーの内容を変更することがあります。変更後の本ポリシーは、本サービス上に掲示した時点から効力を生じるものとします。
        </p>
      </Section>

      <Section title="第11条 (お問い合わせ窓口)">
        <p className="text-sm text-slate-700 mb-2">本ポリシーに関するお問い合わせは、以下の窓口までお願いいたします。</p>
        <ul className="list-disc list-inside text-sm text-slate-700 space-y-1">
          <li>事業者名: {'{{COMPANY_NAME}}'}</li>
          <li>連絡先: {'{{EMAIL}}'}</li>
        </ul>
      </Section>

      <hr className="border-slate-200 my-8" />

      <p className="text-xs text-slate-500">
        {'{{LAST_UPDATED}}'} 制定
        <br />
        {'{{LAUNCH_DATE}}'} 施行
      </p>
    </article>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section>
      <h2 className="text-lg font-bold text-slate-900 mb-3">{title}</h2>
      {children}
    </section>
  )
}
