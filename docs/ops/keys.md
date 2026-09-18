# Claves maestras (NFR-9)

Los servicios Go (`libs/go/oe/keyring`) y Node (`@oe/ts-common/keyring`) leen el mismo anillo de claves desde dos variables. Si falta alguna, o si una clave no mide 32 bytes, el servicio no arranca.

| Variable | Formato | Ejemplo |
|---|---|---|
| `OE_MASTER_KEYS` | `kid:base64,kid:base64`, cada clave de 32 bytes | `k2026a:3q2+7w...=,k2026b:q83v...=` |
| `OE_MASTER_KEY_ID` | el `kid` activo, que debe estar en el anillo | `k2026b` |

El `kid` no puede contener `.`, `,`, `:` ni espacios. Conviene usar la fecha de alta, por ejemplo `k2026a`.

## Generar una clave

```sh
openssl rand -base64 32
```

Guardarla en el gestor de secretos del entorno. Nunca se versiona una clave que no sea de desarrollo.

## Qué se hace con la clave

- `Derive(purpose, tenant)` aplica HKDF-SHA256 sobre la clave activa con info `oe/<purpose>/<tenant>`. Por ejemplo, los tokens de tracking usan purpose `track`. Una clave derivada cambia al rotar la clave activa.
- `Seal(purpose, plaintext)` cifra con AES-256-GCM usando la subclave HKDF-SHA256 con info `oe-seal/<purpose>`. Produce un sobre `v1.<kid>.<nonce>.<ciphertext>` en base64url sin padding, donde el ciphertext incluye el tag de 16 bytes.
- `Open(purpose, sealed)` descifra con la clave del `kid` que trae el sobre, esté activa o no.

`libs/go/oe/keyring/testdata/vectors.json` fija el formato. Las implementaciones de Go y de Node lo verifican, así que cada una puede leer los sobres de la otra.

## Rotación

1. Generar una clave nueva y agregarla a `OE_MASTER_KEYS` sin quitar las anteriores. Desplegar todos los servicios.
2. Cambiar `OE_MASTER_KEY_ID` al `kid` nuevo y volver a desplegar. Desde ese momento los sobres nuevos salen con el `kid` nuevo, y los viejos se siguen abriendo.
3. Correr el job de re-sellado: lee cada secreto con `Open` y lo vuelve a guardar con `Seal`.
4. Cuando ningún sobre use el `kid` viejo, quitarlo de `OE_MASTER_KEYS` y desplegar.

Hay que hacer el paso 1 en todos los servicios antes del paso 2. Si no, un servicio con el anillo viejo recibe sobres con un `kid` que no conoce (`ErrUnknownKID`).

Las claves derivadas con `Derive` (por ejemplo, los tokens de tracking) no se re-sellan. Al cambiar la clave activa, los tokens emitidos con la anterior dejan de validar.
