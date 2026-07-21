#!/usr/bin/env node
// typescript-language-server が実際に型診断を返すことを検証する standalone script。
// 「claude plugin list」等の存在確認は binary が起動するかしか見ない。ここでは
// stdio 経由の最小 LSP client を実装し、型エラーを含む probe file を開いて
// publishDiagnostics を受信できるかを実証する(汎用 LSP client 化はしない = YAGNI)。
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TIMEOUT_MS = 30_000;
const QUIESCENCE_MS = 500; // tsls 内部の publishDiagnostics 集約 debounce(50ms)の 10x 余裕
const PROBE_CODE = 'const n: number = "x";\n'; // TS2322 を必ず生む型エラー probe

// probe は一時 dir に単独で置く(package.json/node_modules を持たない)。
// typescript-language-server の暗黙 sibling 解決(自動で tsserver を探す挙動)に
// 依存せず、pin 済み global typescript の tsserver.js を initializationOptions で
// 明示指定する。global の typescript が変わり tsserver.js の配置が変われば、
// ここの解決自体が失敗して原因が分かりやすい形で表面化する。
function resolveGlobalTsserverPath() {
  const npmRoot = execFileSync('npm', ['root', '-g']).toString().trim();
  return join(npmRoot, 'typescript', 'lib', 'tsserver.js');
}

async function main() {
  let tmpDir;
  let child;

  try {
    const tsserverPath = resolveGlobalTsserverPath();
    tmpDir = mkdtempSync(join(tmpdir(), 'lsp-verify-'));
    const probePath = join(tmpDir, 'probe.ts');
    const probeUri = `file://${probePath}`;
    writeFileSync(probePath, PROBE_CODE);

    child = spawn('typescript-language-server', ['--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buffer = Buffer.alloc(0);
    let initializeId = null;
    let resolveDiagnostics;
    let rejectDiagnostics;
    let settled = false;
    let quiescenceTimer = null;
    let stderrBuf = '';

    const diagnosticsPromise = new Promise((resolve, reject) => {
      resolveDiagnostics = resolve;
      rejectDiagnostics = reject;
    });

    function settleSuccess(diagnostics) {
      if (settled) return;
      settled = true;
      if (quiescenceTimer) clearTimeout(quiescenceTimer);
      resolveDiagnostics(diagnostics);
    }

    function settleFailure(err) {
      if (settled) return;
      settled = true;
      if (quiescenceTimer) clearTimeout(quiescenceTimer);
      rejectDiagnostics(err);
    }

    function send(message) {
      const json = JSON.stringify(message);
      const header = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n`;
      child.stdin.write(header + json);
    }

    function onInitializeResult() {
      send({ jsonrpc: '2.0', method: 'initialized', params: {} });
      send({
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: {
          textDocument: {
            uri: probeUri,
            languageId: 'typescript',
            version: 1,
            text: PROBE_CODE,
          },
        },
      });
    }

    function handleMessage(message) {
      if (message.id === initializeId && message.result) {
        onInitializeResult();
        return;
      }
      if (
        message.method === 'textDocument/publishDiagnostics' &&
        message.params?.uri === probeUri
      ) {
        const diagnostics = message.params.diagnostics ?? [];
        if (diagnostics.length >= 1) {
          // tsls は Syntax/Semantic/Suggestion を共有 map 経由・50ms debounce で
          // 集約 publish するため、空 syntax → 非空 semantic の2段 publish が
          // 起き得る(typescript-language-server@5.3.0 実装より)。型エラー probe
          // は semantic 診断が届いた瞬間に確定するので、非空を見た時点で即 resolve
          // する(先に届く空 publish を掴んでしまう race を構造的に排除)。
          settleSuccess(diagnostics);
        } else {
          // 空 publish: この後に非空 publish が来る可能性があるため即断しない。
          // QUIESCENCE_MS 内に非空が来なければ「診断なし」で確定する
          // (clean probe の RED を 30s timeout 待ちにせず速く返す)。
          if (quiescenceTimer) clearTimeout(quiescenceTimer);
          quiescenceTimer = setTimeout(() => settleSuccess([]), QUIESCENCE_MS);
        }
      }
    }

    child.stderr.on('data', (d) => {
      stderrBuf += d.toString();
    });

    child.stdout.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      // Content-Length framing: 1 read に複数/断片メッセージが跨る前提で解く。
      for (;;) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;
        const header = buffer.subarray(0, headerEnd).toString('utf8');
        const match = /Content-Length: (\d+)/i.exec(header);
        if (!match) {
          // 想定外ヘッダ (Content-Type 単体等)。次フレームへ読み進める。
          buffer = buffer.subarray(headerEnd + 4);
          continue;
        }
        const contentLength = Number(match[1]);
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + contentLength;
        if (buffer.length < bodyEnd) break; // 断片: 続きを待つ
        const body = buffer.subarray(bodyStart, bodyEnd).toString('utf8');
        buffer = buffer.subarray(bodyEnd);
        try {
          handleMessage(JSON.parse(body));
        } catch {
          // 診断以外の不正/非対象メッセージは無視
        }
      }
    });

    child.on('error', (err) => settleFailure(err));
    // stdin write 先の stream に 'error' listener が無いと、child が stdin を
    // 既に閉じている場合の EPIPE が unhandled になり process が crash する。
    // 他の早期終了(spawn 失敗 / 早期 exit)と同じ settleFailure 経路へ流し、
    // 常に「NG: 理由」で fail-closed に揃える。
    child.stdin.on('error', (err) => settleFailure(err));
    child.on('exit', (code, signal) => {
      // server が診断を送る前に落ちた/終了した場合、30s timeout を待たず
      // 原因(exit code/signal + stderr tail)を添えて fast fail する。
      // 既に resolve/reject 済みなら settled ガードで no-op(finally の
      // child.kill() 由来の exit も同様に無害)。
      settleFailure(
        new Error(
          `language server が診断前に終了 (code=${code} signal=${signal})${
            stderrBuf ? ': ' + stderrBuf.slice(-500) : ''
          }`,
        ),
      );
    });

    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        processId: process.pid,
        rootUri: `file://${tmpDir}`,
        capabilities: { textDocument: { publishDiagnostics: {} } },
        initializationOptions: { tsserver: { path: tsserverPath } },
      },
    };
    initializeId = initRequest.id;
    send(initRequest);

    const timeout = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`timeout after ${TIMEOUT_MS}ms (no diagnostics)`)),
        TIMEOUT_MS,
      ),
    );

    const diagnostics = await Promise.race([diagnosticsPromise, timeout]);
    if (diagnostics.length < 1) {
      throw new Error('publishDiagnostics に diagnostics が 0 件');
    }
    console.log(`OK: ${diagnostics.length} diagnostic(s) received for ${probeUri}`);
    return 0;
  } catch (err) {
    console.error(`NG: ${err.message}`);
    return 1;
  } finally {
    if (child) child.kill();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().then((code) => process.exit(code));
