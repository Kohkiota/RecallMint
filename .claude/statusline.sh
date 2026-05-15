#!/usr/bin/env node
// Claude Code statusLine: model name, context usage, session cost
// 注意: context_window の数値は累積トークンバグあり (issue #13783)

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  let d;
  try {
    d = JSON.parse(input);
  } catch {
    process.stdout.write("[statusLine: invalid JSON]");
    return;
  }

  const model = d.model?.display_name ?? "?";
  const used = Math.floor(d.context_window?.used_percentage ?? 0);
  const left = Math.floor(d.context_window?.remaining_percentage ?? 0);
  const cost = (d.cost?.total_cost_usd ?? 0).toFixed(2);

  // 残量が少ないほど赤
  const color = left < 20 ? "\x1b[91m" : left < 50 ? "\x1b[33m" : "\x1b[32m";
  const reset = "\x1b[0m";

  process.stdout.write(
    `[${model}] Context: ${color}${used}% used / ${left}% left${reset} | $${cost}`
  );
});