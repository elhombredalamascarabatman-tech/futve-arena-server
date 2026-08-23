# Cómo publicar el servidor real de FUTVE Arena (Render — sin tarjeta)

Esto es la segunda mitad de "jugar en línea": ya existe la sala/código
(eso vive en Firebase, como el resto de la página). Lo que falta es un
**servidor propio** que controle la física del partido de verdad, para
que nadie pueda hacer trampa moviendo su jugador donde quiera.

Elegiste publicarlo en **Render** (en vez de Google Cloud Run) porque
Render tiene un plan gratuito que **no pide tarjeta**. Yo ya escribí y
probé todo el código del servidor — necesito que hagas estos pasos
porque requieren crear cuentas con tu propio correo, algo que solo vos
podés hacer.

Son tres partes: (1) subir el código a GitHub, (2) conectar Render a
ese código, (3) darle al servidor la llave para reconocer a los
usuarios de tu Firebase. Ninguna requiere escribir código, todo es
clic y copiar/pegar.

---

## Parte 1 — Subir el código a GitHub (gratis, sin tarjeta)

1. Andá a **https://github.com** y creá una cuenta gratis (con tu correo).
2. Ya adentro, hacé clic en el botón verde **"New"** (o el `+` arriba a
   la derecha → "New repository") para crear un repositorio nuevo.
3. Ponele de nombre `futve-arena-server`. Dejalo como **Public**
   (público). No marques ninguna otra opción. Clic en **"Create repository"**.
4. En la página del repositorio recién creado, buscá el enlace que dice
   **"uploading an existing file"** (o el botón "Add file" → "Upload files").
5. Descomprimí el `futve-arena-server.zip` que te envié (si todavía no
   lo hiciste) y arrastrá TODOS los archivos de esa carpeta a la
   ventana de GitHub — **excepto la carpeta `node_modules` si aparece**
   (no debería estar en el zip, pero por si acaso: esa carpeta no se
   sube). Los archivos a subir son: `index.js`, `game.js`, `physics.js`,
   `package.json`, `package-lock.json`, `Dockerfile`, `.dockerignore`.
6. Bajá y hacé clic en **"Commit changes"** (el botón verde). Listo, tu
   código ya está en GitHub.

---

## Parte 2 — Conectar Render y publicar el servidor

1. Andá a **https://render.com** y creá una cuenta gratis — elegí la
   opción **"Sign up with GitHub"** para que quede conectado
   automáticamente con la cuenta que creaste recién (no pide tarjeta).
2. En el panel de Render, hacé clic en **"New +"** → **"Web Service"**.
3. Elegí el repositorio `futve-arena-server` que subiste (Render te
   los lista automáticamente porque ya está conectado a tu GitHub).
4. Render va a detectar el `Dockerfile` solo. Configurá:
   - **Name**: `futve-arena-server` (o el nombre que quieras)
   - **Region**: la más cercana a Venezuela que ofrezca (por ejemplo Ohio/US East)
   - **Instance Type**: **Free**
5. Antes de crear el servicio, bajá hasta **"Environment Variables"** y
   agregá una variable (la vamos a completar en la Parte 3, podés
   dejarla vacía por ahora o volver a editarla después):
   - **Key**: `FIREBASE_SERVICE_ACCOUNT_JSON`
   - **Value**: (la completamos en el paso siguiente)
6. Hacé clic en **"Create Web Service"**. Va a tardar unos minutos en
   construir y arrancar.

Cuando termine, en la parte de arriba de la página del servicio vas a
ver una URL como:

```
https://futve-arena-server.onrender.com
```

Guardala, la necesitamos al final.

---

## Parte 3 — Darle al servidor la llave para reconocer a tus usuarios

El servidor necesita poder confirmar "esta persona sí inició sesión en
mi sitio" sin depender de que el navegador le mienta. Para eso usa una
llave especial de tu propio proyecto de Firebase (no es una cuenta
nueva, es una credencial DEL MISMO proyecto `gd-futve`):

1. Andá a la **consola de Firebase**: https://console.firebase.google.com
   y abrí tu proyecto `gd-futve`.
2. Hacé clic en el ícono de engranaje ⚙️ (arriba a la izquierda) →
   **"Configuración del proyecto"**.
3. Andá a la pestaña **"Cuentas de servicio"** ("Service accounts").
4. Hacé clic en **"Generar nueva clave privada"** ("Generate new
   private key"). Confirmá. Se va a descargar un archivo `.json` a tu
   computadora (algo como `gd-futve-firebase-adminsdk-xxxxx.json`).

   ⚠️ Este archivo es sensible — es como una contraseña maestra de tu
   proyecto. No lo compartas en ningún otro lado más que en el paso
   siguiente (Render lo guarda de forma privada, no público).

5. Abrí ese archivo `.json` descargado con el Bloc de notas (clic
   derecho → Abrir con → Bloc de notas). Vas a ver un texto largo que
   empieza con `{"type": "service_account", ...}`.
6. Seleccioná TODO ese texto (Ctrl+A) y copialo (Ctrl+C).
7. Volvé a Render, a tu servicio `futve-arena-server` → pestaña
   **"Environment"** → editá la variable `FIREBASE_SERVICE_ACCOUNT_JSON`
   que creaste antes (o creála si no la creaste) y pegá ahí todo el
   contenido del archivo `.json` como valor.
8. Guardá — Render va a reiniciar el servicio solo con la nueva
   variable.

---

## Paso final — pegame la URL

Copiá la URL que te dio Render (`https://futve-arena-server.onrender.com`
o similar) y pegámela acá en el chat. Con eso conecto el modo "Jugar en
línea" del sitio a tu servidor real.

## Notas importantes

- **El plan gratis de Render "duerme" el servidor después de un rato
  sin uso** (unos 15 minutos sin partidas activas). La primera conexión
  después de eso puede tardar 30-60 segundos en "despertar" — a partir
  de ahí funciona normal mientras haya gente jugando. Si más adelante
  esto molesta, se puede pasar a un plan pago de Render (sí pide
  tarjeta) o volver a la opción de Cloud Run.
- Nunca compartas el archivo `.json` de la cuenta de servicio ni lo
  subas a GitHub — solo va pegado como variable de entorno privada en
  Render. Si en algún momento pensás que se filtró, desde la misma
  pantalla de "Cuentas de servicio" en Firebase podés revocar esa
  llave y generar una nueva.
- Si más adelante querés actualizar el servidor (por ejemplo, si te
  mando una versión nueva de estos archivos), subís los archivos
  nuevos a ese mismo repositorio de GitHub (mismo botón "Add file" →
  "Upload files", sobrescribiendo los que cambiaron) y Render vuelve a
  publicar solo automáticamente.
