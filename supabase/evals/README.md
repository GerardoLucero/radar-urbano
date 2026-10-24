# Evals de las funciones con IA

`cases.json` tiene 50 casos etiquetados:

| Grupo | Casos | Que mide |
|---|---|---|
| `classify` | 20 | categoria esperada (lista de alternativas aceptables) |
| `dedupe` | 10 | si el reporte nuevo es el mismo evento que un candidato, o ninguno |
| `corroborate` | 10 | `corroborates` o `contradicts` frente a reportes previos del mismo numero |
| adversariales | 10 | intentos de inyeccion de prompt: la salida no debe obedecer ni salirse del esquema |

`run.ts` usa los mismos prompts, esquemas zod y cliente (`_shared/llm.ts`) que las funciones.

## Ejecutar

Requiere al menos una llave. Hace llamadas reales al proveedor (consume cuota), por eso **no corre en CI**
sin llaves: sin `GROQ_API_KEY` ni `NVIDIA_NIM_API_KEY` el script termina con codigo 0 y un aviso.

```sh
GROQ_API_KEY=... deno run --allow-env --allow-net --allow-read supabase/evals/run.ts
# solo un grupo: --only=classify | dedupe | corroborate | adversarial
```

Variables opcionales: `GROQ_MODEL`, `NIM_MODEL`, `NVIDIA_NIM_API_KEY`, `EVAL_MIN_ACCURACY` (0.8 por defecto),
`EVAL_DELAY_MS` (300 por defecto).

El codigo de salida es 1 si el acierto total queda bajo el minimo. Una salida que no valida el esquema
cuenta como fallo y se reporta aparte (para los casos adversariales es el comportamiento seguro, pero conviene revisarlo).
