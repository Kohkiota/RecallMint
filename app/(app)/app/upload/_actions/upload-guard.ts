// FormData から受け取った投入先選択 (前端 Destination 型と整合)。
export type Destination =
  | { mode: 'new' }
  | { mode: 'existing'; examId: string }
