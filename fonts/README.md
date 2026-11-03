# 폰트

## 포함된 폰트

| 파일 | 폰트 | 라이선스 |
|---|---|---|
| Pretendard-Regular.ttf, Pretendard-Bold.ttf | Pretendard 1.3.9 | SIL Open Font License 1.1 — Copyright (c) 2021, Kil Hyung-jin, with Reserved Font Name Pretendard. <https://github.com/orioncactus/pretendard/blob/main/LICENSE> |

맑은 고딕은 Microsoft 폰트라 여기에 넣지 않습니다. PDF 저장 시 사용자 PC(`C:\Windows\Fonts`)에서 불러옵니다.

## 폰트를 추가해 함께 배포하기

1. TTF 또는 OTF 파일을 이 폴더에 넣습니다. **재배포가 허용된 폰트**(OFL, 무료 상업용 등)만 넣으세요.
2. `fonts.json`에 항목을 추가합니다. `bold`는 없어도 됩니다.

```json
[
  { "key": "Pretendard", "label": "Pretendard", "files": { "normal": "Pretendard-Regular.ttf", "bold": "Pretendard-Bold.ttf" } },
  { "key": "NanumMyeongjo", "label": "나눔명조", "files": { "normal": "NanumMyeongjo-Regular.ttf", "bold": "NanumMyeongjo-Bold.ttf" } }
]
```

- `key`: 영문·숫자로 된 고유 이름 (저장된 문서가 이 이름으로 폰트를 찾습니다)
- `label`: 화면에 보일 이름
- 목록 첫 항목이 아니어도 기본 폰트는 Pretendard입니다 (`js/fonts.js`의 `DEFAULT_FONT`).

PDF에는 실제로 쓴 글자만 담기므로 폰트 파일이 커도 결과 PDF는 작게 유지됩니다.
