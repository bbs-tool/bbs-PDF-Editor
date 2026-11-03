# 로컬 실행용 서버. 브라우저가 예전 파일을 캐시해 두지 않도록 매번 새로 확인하게 한다.
import functools
import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.wasm': 'application/wasm'}

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    root = os.path.dirname(os.path.abspath(__file__))
    handler = functools.partial(NoCacheHandler, directory=root)
    # Windows에서는 재사용 옵션이 켜져 있으면 같은 포트에 서버가 두 개 뜰 수 있어 끈다
    http.server.ThreadingHTTPServer.allow_reuse_address = False
    try:
        server = http.server.ThreadingHTTPServer(('127.0.0.1', port), handler)
    except OSError:
        print(f'{port}번 포트를 이미 사용 중입니다. 편집기가 이미 실행 중이면 이 창은 닫아도 됩니다.')
        sys.exit(1)
    server.serve_forever()
