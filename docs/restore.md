# Restauración de prueba del backup

El workflow `.github/workflows/backup.yml` genera cada noche un volcado de la base (`pg_dump`, formato custom, esquema `public`) cifrado con `age` y lo sube como artefacto privado de GitHub Actions con retención de 14 días.

Alcance: solo el esquema `public` (reportes, sujetos, evidencias, tablas de contexto, funciones y vistas). **No incluye** los archivos de Storage (`evidence-private`, `evidence-public`) ni el esquema `auth`. Para las imágenes, ver la sección "Storage" de `RUNBOOK.md`.

## Requisitos

- La **clave privada** `age` que corresponde a `BACKUP_AGE_RECIPIENT` (guardada fuera de GitHub, en el gestor de contraseñas; ver inventario en `RUNBOOK.md`).
- `age` y `postgresql-client` (>= 15) instalados localmente.
- Una base **vacía y desechable** para la prueba. Nunca restaurar sobre producción como prueba.

## Generar el par de claves (una sola vez)

```bash
age-keygen -o radar-backup.key      # guarda este archivo en el gestor de contraseñas, NO en el repo
# La salida muestra: "Public key: age1...". Ese valor va en el secreto BACKUP_AGE_RECIPIENT.
```

## Restauración de prueba, paso a paso

1. **Descargar el artefacto.** Actions > Backup > último run exitoso > artefacto `db-backup` (o `gh run download <run-id> -n db-backup`).
2. **Verificar integridad.**
   ```bash
   sha256sum -c radar-urbano-<fecha>.dump.age.sha256
   ```
3. **Descifrar.**
   ```bash
   age -d -i radar-backup.key -o radar.dump radar-urbano-<fecha>.dump.age
   ```
4. **Levantar una base desechable.**
   ```bash
   docker run --rm -d --name ru-restore -e POSTGRES_PASSWORD=test -p 54329:5432 postgres:16
   ```
   Las extensiones que use el esquema (por ejemplo `pgcrypto`, `pg_cron`, `postgis`) deben existir; en una base local sin `pg_cron` ignora los errores de esa extensión.
5. **Restaurar.**
   ```bash
   pg_restore --no-owner --no-privileges --exit-on-error \
     -d "postgresql://postgres:test@localhost:54329/postgres" radar.dump
   ```
   Si algún objeto falla por un rol de Supabase inexistente (`anon`, `authenticated`, `service_role`), créalos primero: `create role anon; create role authenticated; create role service_role;`.
6. **Comprobar contenido.**
   ```sql
   select count(*) from reports;
   select status, count(*) from reports group by 1;
   select max(created_at) from reports;   -- debe ser de las últimas 24 h
   ```
   Compara los conteos con producción (solo lectura, desde Supabase Studio).
7. **Destruir todo.**
   ```bash
   docker rm -f ru-restore && shred -u radar.dump 2>/dev/null || rm -P radar.dump
   ```
8. **Registrar la prueba**: fecha, quién, run del backup usado, resultado, en la bitácora de operaciones.

Haz esta prueba **una vez al mes** y después de cualquier cambio del workflow de backup.

## Restauración real (incidente)

Ver `RUNBOOK.md`, sección "Restaurar un backup". Resumen: crear un proyecto Supabase nuevo (o usar una base vacía), restaurar con los pasos 3 a 5, reaplicar migraciones posteriores al backup, volver a crear los secretos de las funciones y apuntar `SUPABASE_URL`/llave anon en `index.html`.

## Qué hacer con el artefacto

- Los artefactos se descargan con permisos de lectura del repositorio. Por eso el volcado va **cifrado**; el repositorio sin la clave privada no sirve para leerlo.
- No copies el volcado descifrado a discos sin cifrar ni a servicios en la nube.
