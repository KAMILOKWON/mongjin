import { writeFileSync } from "node:fs";

const destination = "https://studiozzg.com/mongjin";
const html = `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex" />
    <link rel="canonical" href="${destination}" />
    <meta http-equiv="refresh" content="0; url=${destination}" />
    <title>몽진 — Studio ZZG</title>
    <script>location.replace(${JSON.stringify(destination)} + location.search + location.hash);</script>
  </head>
  <body>
    <p><a href="${destination}">몽진의 새 주소로 이동하기</a></p>
  </body>
</html>
`;

writeFileSync(new URL("../dist/index.html", import.meta.url), html);
writeFileSync(new URL("../dist/404.html", import.meta.url), html);
