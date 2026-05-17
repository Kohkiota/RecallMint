// 利用規約。波括弧 2 重括り (例: {{COMPANY_NAME}}, {{PRICE}} 等の 12 placeholder)
// は docs/legal-placeholders.md の sed 置換対象。JSX 内 `{'<key>'}` 表記は、
// そのまま literal 文字列を render する。
// SERVICE_NAME は 2026-05-17 placeholder 撤回、 RecallMint hardcode に統一。

export const metadata = {
  title: '利用規約',
  description: '本サービスの利用条件を定めた利用規約のページです。',
}

export default function TermsPage() {
  return (
    <article className="max-w-3xl mx-auto w-full px-4 py-8 md:py-12 space-y-6">
      <h1 className="text-2xl font-bold text-slate-900">利用規約</h1>

      <p className="text-sm text-slate-700 leading-relaxed">
        本利用規約 (以下「本規約」といいます) は、{'{{COMPANY_NAME}}'} (以下
        「当社」といいます) が提供する RecallMint (以下「本サービス」
        といいます) の利用条件を定めるものです。利用者の皆さま (以下「ユーザー」
        といいます) には、本規約に従って本サービスをご利用いただきます。
      </p>

      <Section title="第1条 (適用)">
        <ol className="list-decimal list-inside space-y-2 text-sm text-slate-700">
          <li>本規約は、ユーザーと当社との間の本サービスの利用に関わる一切の関係に適用されるものとします。</li>
          <li>本規約の内容と、規約外の説明等の内容に齟齬が生じた場合、本規約の規定が優先します。</li>
          <li>本規約において用いる用語の定義は次のとおりです。
            <ul className="list-disc list-inside ml-4 mt-1 space-y-1">
              <li>「本サービス」: 当社が提供する RecallMint</li>
              <li>「ユーザー」: 本規約に同意の上、本サービスを利用する個人</li>
            </ul>
          </li>
        </ol>
      </Section>

      <Section title="第2条 (利用登録)">
        <ol className="list-decimal list-inside space-y-2 text-sm text-slate-700">
          <li>本サービスの利用登録は、Clerk (Clerk, Inc. が運営する認証サービス) のアカウント作成を通じて行うものとします。</li>
          <li>利用希望者が未成年者である場合、法定代理人 (親権者または未成年後見人) の同意を得たうえで利用登録を行ってください。</li>
          <li>当社は、以下のいずれかに該当する場合、利用登録の申請を承認しないことがあります。
            <ol className="list-decimal list-inside ml-4 mt-1 space-y-1">
              <li>本規約に違反したことがある者からの申請である場合</li>
              <li>申請に際し、虚偽の情報を提供した場合</li>
              <li>その他、当社が利用登録を相当でないと判断した場合</li>
            </ol>
          </li>
        </ol>
      </Section>

      <Section title="第3条 (ユーザー ID およびパスワードの管理)">
        <ol className="list-decimal list-inside space-y-2 text-sm text-slate-700">
          <li>ユーザー ID およびパスワードを含む認証情報の管理は、Clerk により行われます。</li>
          <li>ユーザーは、自己の認証情報を第三者に利用させ、または貸与・譲渡・売買してはなりません。</li>
          <li>認証情報の管理不十分、使用上の過誤、第三者の使用等によって生じた損害について、当社は一切の責任を負いません。</li>
        </ol>
      </Section>

      <Section title="第4条 (料金および支払方法)">
        <ol className="list-decimal list-inside space-y-2 text-sm text-slate-700">
          <li>有料プランの利用料金は、{'{{PRICE}}'} (税込・月額) とします。</li>
          <li>利用料金の支払いは、Stripe, Inc. が運営する決済代行サービスを介し、クレジットカードによるものとします。</li>
          <li>有料プランは、申込み完了後、初回課金が成功した時点から開始されます。</li>
          <li>有料プランは、各課金期間 (1 か月) 終了時に自動的に更新されます。次回更新を希望しない場合、ユーザーは次回更新日の前日までに解約手続を行うものとします。</li>
          <li>解約手続後も、現在の課金期間の終了日までは引き続き本サービスをご利用いただけます。</li>
        </ol>
      </Section>

      <Section title="第5条 (禁止事項)">
        <p className="text-sm text-slate-700 mb-2">ユーザーは、本サービスの利用にあたり、以下の各号に掲げる行為を行ってはなりません。</p>
        <ol className="list-decimal list-inside space-y-1 text-sm text-slate-700">
          <li>法令または公序良俗に違反する行為</li>
          <li>犯罪行為に関連する行為</li>
          <li>当社、本サービスの他のユーザー、または第三者のサーバまたはネットワークの機能を破壊し、または妨害する行為</li>
          <li>当社のサービスの運営を妨害するおそれのある行為</li>
          <li>他のユーザーに関する個人情報等を収集または蓄積する行為</li>
          <li>不正アクセスをし、またはこれを試みる行為</li>
          <li>他のユーザーに成りすます行為</li>
          <li>当社が許諾しない本サービス上での宣伝、広告、勧誘、または営業行為</li>
          <li>本サービスを、本来の目的と異なる目的で利用する行為</li>
          <li>反社会的勢力に対して直接または間接に利益を供与する行為</li>
          <li>本サービスのリバースエンジニアリング、逆コンパイル、逆アセンブル等を行う行為</li>
          <li>当社、他のユーザーまたはその他の第三者の知的財産権、肖像権、プライバシー、名誉その他の権利または利益を侵害する行為</li>
          <li>その他、当社が不適切と判断する行為</li>
        </ol>
      </Section>

      <Section title="第6条 (本サービスの提供の停止等)">
        <ol className="list-decimal list-inside space-y-2 text-sm text-slate-700">
          <li>当社は、以下のいずれかに該当する場合、ユーザーに事前に通知することなく、本サービスの全部または一部の提供を停止または中断することができるものとします。
            <ol className="list-decimal list-inside ml-4 mt-1 space-y-1">
              <li>本サービスにかかるコンピュータシステムの保守点検または更新を行う場合</li>
              <li>地震、落雷、火災、停電または天災などの不可抗力により、本サービスの提供が困難となった場合</li>
              <li>コンピュータまたは通信回線等が事故により停止した場合</li>
              <li>その他、当社が本サービスの提供が困難と判断した場合</li>
            </ol>
          </li>
          <li>当社は、本サービスの提供の停止または中断により、ユーザーまたは第三者が被ったいかなる不利益または損害についても、一切の責任を負わないものとします。</li>
        </ol>
      </Section>

      <Section title="第7条 (利用制限および登録抹消)">
        <ol className="list-decimal list-inside space-y-2 text-sm text-slate-700">
          <li>当社は、ユーザーが以下のいずれかに該当する場合には、事前の通知なく、本サービスの全部もしくは一部の利用を制限し、またはユーザー登録を抹消することができるものとします。
            <ol className="list-decimal list-inside ml-4 mt-1 space-y-1">
              <li>本規約のいずれかの条項に違反した場合</li>
              <li>登録事項に虚偽の事実があることが判明した場合</li>
              <li>利用料金等の支払債務の不履行があった場合</li>
              <li>当社からの連絡に対し、相当の期間内に応答がない場合</li>
              <li>最終のサービス利用から相当期間にわたり利用がなされていない場合</li>
              <li>その他、当社が本サービスの利用を相当でないと判断した場合</li>
            </ol>
          </li>
          <li>前項各号に基づき当社が行った行為によりユーザーに生じた損害について、当社は一切の責任を負いません。</li>
        </ol>
      </Section>

      <Section title="第8条 (退会)">
        <p className="text-sm text-slate-700">
          ユーザーは、本サービス内のアカウント設定画面から退会手続 (アカウント削除) を行うことができます。退会した場合、登録した語彙データおよび学習履歴は復元できませんので、ご了承ください。
        </p>
      </Section>

      <Section title="第9条 (保証の否認および免責事項)">
        <ol className="list-decimal list-inside space-y-2 text-sm text-slate-700">
          <li>当社は、本サービスに事実上または法律上の瑕疵 (安全性、信頼性、正確性、完全性、有効性、特定の目的への適合性、セキュリティなどに関する欠陥、エラーやバグ、権利侵害などを含みます) がないことを明示的にも黙示的にも保証しておりません。</li>
          <li>当社は、本サービスに起因してユーザーに生じたあらゆる損害について、当社の故意または重過失による場合を除き、一切の責任を負いません。</li>
          <li>前項にかかわらず、本サービスに関する当社の損害賠償責任は、ユーザーが当該損害の発生時より過去 12 か月間に当社に対して支払った利用料金の総額を上限とします。</li>
          <li>当社は、本サービスに関して、ユーザーと他のユーザーまたは第三者との間において生じた取引、連絡または紛争等について、一切責任を負いません。</li>
        </ol>
      </Section>

      <Section title="第10条 (サービス内容の変更等)">
        <p className="text-sm text-slate-700">
          当社は、ユーザーへの事前の通知をもって、本サービスの内容を変更、追加または廃止することがあり、ユーザーはこれを承諾するものとします。
        </p>
      </Section>

      <Section title="第11条 (利用規約の変更)">
        <ol className="list-decimal list-inside space-y-2 text-sm text-slate-700">
          <li>当社は以下の場合に、ユーザーの個別の同意を要することなく、本規約を変更できるものとします。
            <ol className="list-decimal list-inside ml-4 mt-1 space-y-1">
              <li>本規約の変更がユーザーの一般の利益に適合するとき。</li>
              <li>本規約の変更が、契約をした目的に反せず、かつ、変更の必要性、変更後の内容の相当性、変更の内容その他の変更にかかる事情に照らして合理的なものであるとき。</li>
            </ol>
          </li>
          <li>当社は、前項による本規約の変更にあたり、変更後の本規約の効力発生時期を定め、かつ変更後の本規約の内容ならびにその効力発生時期を本サービス上に掲示する方法その他の適切な方法により周知するものとします。</li>
        </ol>
      </Section>

      <Section title="第12条 (個人情報の取扱い)">
        <p className="text-sm text-slate-700">
          当社は、本サービスの利用によって取得する個人情報については、当社のプライバシーポリシーに従い適切に取り扱うものとします。
        </p>
      </Section>

      <Section title="第13条 (通知または連絡)">
        <p className="text-sm text-slate-700 leading-relaxed">
          ユーザーと当社との間の通知または連絡は、当社の定める方法によって行うものとします。当社は、ユーザーから当社が別途定める方式に従った変更届出がない限り、現在登録されている連絡先 (登録メールアドレスを含みます) が有効なものとみなして当該連絡先へ通知または連絡を行い、これらは発信時にユーザーへ到達したものとみなします。
        </p>
      </Section>

      <Section title="第14条 (権利義務の譲渡の禁止)">
        <p className="text-sm text-slate-700">
          ユーザーは、当社の書面による事前の承諾なく、利用契約上の地位または本規約に基づく権利もしくは義務を第三者に譲渡し、または担保に供することはできません。
        </p>
      </Section>

      <Section title="第15条 (準拠法・裁判管轄)">
        <ol className="list-decimal list-inside space-y-2 text-sm text-slate-700">
          <li>本規約の解釈にあたっては、日本法を準拠法とします。</li>
          <li>本サービスに関して紛争が生じた場合には、{'{{JURISDICTION}}'} を専属的合意管轄裁判所とします。</li>
        </ol>
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
