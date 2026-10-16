# SQL ERD Visual Editor (`sql-erd-visualizer`)

Extensión para VS Code que permite abrir cualquier archivo `.sql` o `.ddl` como un **Diagrama Entidad-Relación (ERD) interactivo** con sincronización bidireccional en tiempo real, soportando **PostgreSQL, MySQL y SQLite**.

## Características principales

- **Soporte Multi-Dialecto Automático:** Detecta y genera sintaxis de **PostgreSQL**, **MySQL / MariaDB** (`ENGINE=InnoDB`, backticks) y **SQLite** (`REFERENCES` inline). Puedes cambiar el dialecto desde la barra superior del diagrama y el archivo `.sql` se adapta al instante.
- **Sincronización Bidireccional (`CustomTextEditorProvider`):**
  - **SQL → Diagrama:** Si editas el archivo `.sql` a mano en el editor de texto, el diagrama actualiza sus tablas, columnas y relaciones en vivo.
  - **Diagrama → SQL:** Puedes crear tablas, agregar/renombrar/eliminar columnas, marcar llaves primarias (`PK`) y arrastrar conexiones entre columnas para crear llaves foráneas (`FOREIGN KEY`). Todo cambio actualiza el `.sql` y respeta `Ctrl+Z` (Undo/Redo) y `Ctrl+S`.
- **Persistencia de Posiciones `(x, y)`:** Guarda las coordenadas de tus tablas en un comentario limpio al final del archivo (`-- @sql-erd-layout: {...}`) para que no pierdas el orden visual al cerrar VS Code.

## Cómo probar la extensión en VS Code

1. Abre la carpeta del proyecto en VS Code:
   ```bash
   code projects/sql-erd-extension
   ```
2. Instala las dependencias y compila (si no lo has hecho ya):
   ```bash
   npm install
   npm run compile
   ```
3. Presiona **`F5`** en VS Code. Se abrirá una nueva ventana (*Extension Development Host*) cargando automáticamente `examples/ecommerce_schema.sql`.
4. Haz clic en el icono **"SQL ERD: Abrir Diagrama Visual al Lado"** (arriba a la derecha del editor) o haz clic derecho sobre cualquier archivo `.sql` $\rightarrow$ **Open With...** $\rightarrow$ **SQL ERD Visual Diagram**.
