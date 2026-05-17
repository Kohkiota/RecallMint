// service brand logo (text 版)。 marketing / auth chrome の Header で
// `<Link href="/"><Logo /></Link>` の形で wrap される (href は親責務、
// Logo 自身は単一責任)。
//
// brand 名は hardcode (2026-05-17 placeholder 撤回、 詳細は
// docs/legal-placeholders.md 序文)。 別サービステンプレ流用は
// devcontainer-template repo の責務、 本 repo は RecallMint 固有値で固定。
//
// Phase 2 で image / svg / icon に差し替え予定、 本 file 1 箇所差し替え
// で Header chrome 全更新。
export function Logo() {
  return (
    <span className="text-lg font-bold text-slate-900">
      RecallMint
    </span>
  )
}
