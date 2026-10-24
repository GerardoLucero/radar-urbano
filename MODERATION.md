# Moderación: reportes de hospedaje/Airbnb

Todo reporte que identifica a una persona por nombre (categoría `hospedaje` por ahora,
cualquier categoría futura que use `report_subjects` mañana) entra con `status='pending'`
y **nunca se auto-publica**. Este es el checklist para revisarlo a mano en Supabase Studio
(no hay panel dedicado en esta v1; se justifica solo si hay volumen real).

## SLAs de cola

| Elemento | Plazo máximo |
|---|---|
| Revisar un reporte con nombre en `pending` | 7 días naturales (objetivo: 72 h) |
| Acuse a una persona nombrada o solicitud ARCO | 72 horas |
| Despublicación preventiva tras un reclamo de persona nombrada | 72 horas (despublicar primero) |
| Respuesta de fondo | 20 días hábiles |
| Resolución de una apelación | 10 días hábiles |

Una vez a la semana, revisar que ningún reporte en `pending` exceda el plazo.

## 1. Encontrar reportes pendientes

Supabase Studio > Table Editor > `reports` > filtro `status = pending` y
`category = hospedaje` (o revisa el correo de alerta que llega a `ALERT_EMAIL` cada vez
que entra uno nuevo, con el nombre y si ya hay corroboración).

## 2. Revisar el caso

- Tabla `report_subjects`, filtro `report_id = <id>`: nombre reportado y link del anuncio.
- Tabla `report_evidence`, filtro `report_id = <id>`: `storage_path_private` (si hay imagen).
- Lee la descripción. ¿Es un hecho concreto y verificable, o una queja genérica/ataque personal?
- ¿Hay otro reporte publicado con el mismo nombre (corroboración)? El correo de alerta ya te
  lo dice; si no, consulta `named_report_confidence` con ese `value_normalized`.

## 3. Si hay imagen: redactar ANTES de publicar

**Nunca subas el original al bucket público.** Pasos:
1. Descarga el original desde `evidence-private` (Storage > ese bucket, esa ruta); solo tú
   tienes acceso, por diseño.
2. Recorta al fragmento relevante (el mensaje/conversación que sustenta el reporte).
3. Difumina/tapa: caras, teléfonos, nombres de terceros no reportados, direcciones, datos de pago.
4. Quita metadata EXIF (cualquier editor de imágenes lo hace al re-exportar, o `exiftool -all= archivo.jpg`).
5. Sube el resultado a `evidence-public` con un nombre nuevo (ej. `published/<report_id>.jpg`).
6. Actualiza `report_evidence.storage_path_public_derivative` con esa ruta y marca
   `exif_stripped = true`.

## 4. Publicar o rechazar

Publicar: `update reports set status = 'published' where id = '<id>';`

Si decides que NO se publica (reporte sin sustento, ataque personal, no verificable):
déjalo en `pending`; no hace falta borrarlo, es evidencia de que el sistema funciona.

**Toda decisión se registra en la bitácora** (sección 7).

## 5. Protocolo de baja y apelación

Aplica cuando una persona nombrada, un tercero afectado o una autoridad pide retirar un reporte.

1. **Recibir y acusar** en máximo 72 horas desde el correo a `contacto@radarurbano.org`.
2. **Despublicar primero**: ubicar el reporte y regresarlo a `pending` (`update reports set status = 'pending' where id = '<id>';`). Si hay derivado de imagen público, retirarlo. Esto se hace antes de evaluar el fondo.
3. **Verificar identidad** (sección 6) cuando la persona pide acceso a sus datos o actúa por otra.
4. **Evaluar el fondo**: ¿el reporte es un hecho verificable y sustentado, o un ataque? ¿La persona aporta evidencia contraria? Si dudas, el reporte permanece despublicado.
5. **Resolver** dentro de 20 días hábiles: mantener despublicado, corregir, eliminar o republicar (solo si la revisión lo justifica, con constancia).
6. **Responder** con la plantilla (sección 8).
7. **Apelación**: si la persona responde con asunto "Apelación" dentro de 15 días hábiles, una persona distinta de quien resolvió (o el segundo administrador) revisa y responde en máximo 10 días hábiles. Se informa además la vía ante la autoridad de protección de datos.

## 6. Verificación de identidad

- Pide una coincidencia de datos que solo la persona conozca, o que muestre su identificación oficial por videollamada o por un medio seguro.
- **No se guarda copia de la identificación**: no la descargues, no la reenvíes, no la pegues en tickets. Si llegó adjunta por correo, bórrala del buzón y de la papelera.
- En la bitácora solo se anota: "identidad verificada por [método], [fecha]".

## 7. Bitácora obligatoria (`moderation_log`)

Toda acción de moderación (publicar, rechazar, despublicar, republicar, eliminar, atender solicitud ARCO, desactivar el formulario) debe quedar en la tabla `moderation_log`. Campos esperados (la tabla la crea una migración aparte; confirmar nombres exactos al aplicarla):

| Campo | Contenido |
|---|---|
| fecha y hora | Cuándo se tomó la acción |
| `report_id` | Reporte afectado (o nulo si aplica a la solicitud) |
| acción | `publish`, `reject`, `unpublish`, `republish`, `delete`, `arco`, `appeal` |
| motivo | Una línea, sin datos personales innecesarios |
| moderador | Quién decidió |
| referencia | Número de caso, oficio o correo (sin adjuntar identificaciones) |

Sin entrada en la bitácora, la acción se considera no realizada. La bitácora no contiene copia de identificaciones.

## 8. Plantilla de respuesta a persona nombrada

> Asunto: Re: Soy la persona nombrada / Solicitud ARCO
>
> Hola [nombre]:
>
> Recibimos su mensaje el [fecha] (caso [número]). Como medida preventiva, el reporte señalado quedó despublicado desde el [fecha] mientras lo revisamos.
>
> Para continuar necesitamos [verificar su identidad por un medio seguro / el enlace o fecha aproximada del reporte]. No guardamos copia de su identificación.
>
> Le daremos una respuesta de fondo en un máximo de 20 días hábiles. Si no está de acuerdo con la resolución, puede responder a este correo con el asunto "Apelación" dentro de los 15 días hábiles siguientes.
>
> Atentamente,
> Radar Urbano

Respuesta de cierre: indicar la decisión (eliminado, corregido, se mantiene despublicado, republicado), el motivo en términos generales y cómo apelar. No revelar quién reportó ni el contenido de la evidencia.

## 9. Regla anti-extorsión

- **El reportante no puede retirar ni negociar un reporte.** Una vez enviado, el reporte pertenece al proceso de moderación; solo el moderador decide.
- **Radar Urbano no negocia retiros.** Ninguna persona, reportante o reportado, puede condicionar el retiro o la publicación a un pago, favor o ventaja.
- Si alguien ofrece o pide dinero a cambio de retirar o publicar: no responder sobre el trato, conservar el mensaje, registrar el intento en la bitácora y, si procede, reportarlo a la autoridad.
- Un reclamo legítimo de la persona nombrada se atiende por el protocolo de baja (sección 5), sin intermediarios.

## 10. "Soy la persona nombrada": SLA de 72 horas

Los correos a `contacto@radarurbano.org` con asunto "Soy la persona nombrada..." se
responden en máximo 72 horas y activan el protocolo de la sección 5. Si la persona da contexto que cambia el caso (ej. la otra
parte también incumplió, hay evidencia contraria), puedes:
- Mantener o revertir a `pending` un reporte ya publicado.
- Pedir al reportante evidencia adicional antes de decidir (sin revelar la identidad de quien reclama).

## 11. Expiración automática

Un cron (`expire_uncorroborated_named_reports`, corre diario a las 8am UTC) oculta solo
los reportes con nombre que llevan 90+ días publicados y nunca recibieron un segundo
reporte del mismo nombre. No se borra nada: vuelve a `pending`, republicable a mano
si más tarde aparece corroboración.
