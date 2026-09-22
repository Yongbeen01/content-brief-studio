import { createRequire } from 'node:module';
import { createInline } from '../../web/js/inline.js';

// 브라우저와 같은 파일(web/vendor/markdown-it.min.js)을 쓴다. vendor 폴더는 package.json 으로 CommonJS 표시.
const require = createRequire(import.meta.url);
const markdownit = require('../../web/vendor/markdown-it.min.js');

export const inline = createInline(markdownit);
