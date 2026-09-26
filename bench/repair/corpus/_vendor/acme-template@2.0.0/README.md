# acme-template

```js
import { compile } from 'acme-template';

const hello = compile('Hello, {{name}}!');
hello({ name: 'Ada' }); // 'Hello, Ada!'
compile('Hi {{name}}.{{note}}', { strict: false })({ name: 'Ada' }); // 'Hi Ada.'
```
