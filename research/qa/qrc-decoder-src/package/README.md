# QRC Decoder

A TypeScript library for encrypting and decrypting QRC lyrics format.

## ⚠️ Security Warning

This library implements a **non-standard, proprietary algorithm** that was reverse-engineered from a specific application. It is **NOT** a standard implementation of DES or 3DES.

**DO NOT** use this library for any general-purpose security or cryptographic needs. It is intended *only* for achieving interoperability with the QRC format.

## Installation

Install the package using your favorite package manager.

**npm:**
```bash
npm install qrc-decoder
```

**yarn:**
```bash
yarn add qrc-decoder
```

## Usage

The library exports two main functions, `decryptQrc` and `encryptQrc`.

```javascript
import { decryptQrc, encryptQrc } from 'qrc-decoder';

const encryptedHex = '...';

try {
  const decrypted = decryptQrc(encryptedHex);
  console.log('Decrypted Lyrics:\n', decrypted);
} catch (error) {
  console.error('Decryption failed:', error);
}
```

## API Reference

### `decryptQrc(encryptedHexString: string): string`
Takes a hexadecimal string of encrypted QRC data and returns the decrypted plaintext lyrics as a UTF-8 string. Throws an error if the input is malformed or decryption fails.

### `encryptQrc(plaintext: string): string`
Takes a plaintext lyric string (UTF-8) and returns a hexadecimal string of the encrypted QRC data.

## Acknowledgements

This TypeScript project is a port of the **LyricDecoder** project by SuJiKiNen.

All credit for the original reverse-engineering and algorithm implementation goes to the author of that project. You can find the original repository here:
[https://github.com/SuJiKiNen/LyricDecoder](https://github.com/SuJiKiNen/LyricDecoder)

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.