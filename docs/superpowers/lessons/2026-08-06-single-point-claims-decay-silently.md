# 「単一点」「唯一の経路」という主張は無言で偽になる

- 日付: 2026-08-06
- 発見: ②-4a クローズ stg smoke(`docs/superpowers/sessions/2026-08-06-ocr-2-4a-close-stg-smoke.md` §4)
- 訂正対象: ②-3 の spec / session doc / fact-finding

## 教訓

> **「単一点」「唯一の経路」という主張は、新しい surface が増えたときに無言で偽になる。
> 完全性の主張は、それ自体が壊れやすい。**

## 何が起きたか

②-3 は本文の markdown 画像記法 `![…](…)` を描画側で除去し、「本文に markdown 画像記法が現れない」を
契約として test で固定した。実装・レビューとも「**単一点 = entry-point strip**」— つまり
`MdTableText` / `MdTableBlock` の入口に strip を置けばどの caller もバイパスできない — と記録した。

10 日後の stg smoke で、upload result page の preview に `![](q010-img-1)` が**生表示**されているのを観測した。
preview は markdown component を通らず、`lib/exams/list.ts` の `snippet(question_text, 80)` を
素のテキストとして出しているため、strip を一度も通らない。

## なぜ検出できなかったか

- **調査の問いが「どこが markdown を描画しているか」だった。** fact-finding は `react-markdown` の
  利用箇所を rg で網羅し「card content を描く別 markdown 経路なし」を確認した。この確認自体は正しい。
- **しかし契約は「markdown 描画経路に記法が出ない」ではなく「ユーザーに記法が見えない」だった。**
  問うべきは「**card 本文がユーザーに届く経路はどこか**」で、それは markdown 描画経路の上位集合である。
  素のテキストで本文を出す surface は、markdown を検索する手法では原理的に見つからない。
- **test も同じ盲点を持つ。** 契約 test は strip を持つ component の中に置かれており、component を
  通らない surface が増えても赤くならない。緑は「守られている」ではなく「見ている範囲は守られている」。
- **後から surface が増えたわけですらない。** result page の preview は ②-3 の時点で既に存在した。
  「単一点」は最初から偽で、誰も気付かないまま 3 つの doc に記録された。

## 実務上どうするか

1. **完全性の主張(単一点 / 唯一の経路 / どこからもバイパスできない)を書くときは、その主張を偽にする
   探索を先にやる。** 「この関数を通らずに同じデータがユーザーに届く経路はあるか」を、
   実装の種類(markdown / plain text / API 応答 / ログ / CSV export)を跨いで探す。
   探索の軸が実装手段(react-markdown)になっていたら、それは契約の軸(ユーザーに届く)とずれている。
2. **主張を書くなら適用範囲も同じ文に書く。** 「単一点」ではなく「`MdTableText` / `MdTableBlock` を
   通る描画については単一点」と書けば、範囲外の surface が視野に入る。範囲を書けない主張は書かない。
3. **完全性は test で固定できない**(全 surface を列挙する test は書けない)。固定できるのは
   「この経路では守られる」だけ。だから完全性の主張は doc 上の言明として残り、**誰も壊さないまま
   偽になる**。定期的な実機観測(smoke)がこの種の乖離を見つける唯一の手段になる。

## 同型の危険がある既存の主張

repo 内で同じ形の完全性主張をしている箇所(いずれも現時点で偽と確認されたわけではない・**再点検の候補**):

- `card_asset_refs` の書込は `handleImages` の**単一点**(`docs/audit/2026-07-13-card-asset-refs-normalization-factfinding.md`)
- presigned GET の発行は `resolveAssetUrls` の**単一点**(同 doc)
- `getDb` は `lib/db` 内部に封じ込め(こちらは **lint で機械強制**されているため、主張が偽になれば CI が落ちる = 上の 2 つと質が違う)

**機械強制のある完全性主張と、doc に書いただけの完全性主張は別物**である。後者は本 doc の対象。
