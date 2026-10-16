# SQL ERD Visual Editor

**SQL ERD Visual Editor** transforma cualquier archivo `.sql`, `.ddl`, `.dbml` o `.erd` en un **Diagrama Entidad-Relación (ERD) interactivo y bidireccional** directamente dentro de Visual Studio Code.

Diseña bases de datos visualmente, conecta llaves foráneas arrastrando el mouse y trabaja en tiempo real con tu equipo mientras tu código se mantiene sincronizado automáticamente.

---

## ✨ Características Principales

### 🔄 Sincronización Bidireccional en Tiempo Real
- **Del Código al Diagrama:** Cualquier cambio que escribas en tu archivo `.sql` o `.dbml` actualiza las tablas, columnas y relaciones del diagrama al instante.
- **Del Diagrama al Código:** Crea nuevas tablas, agrega o edita columnas, define llaves primarias (`PK`) y arrastra conexiones entre columnas para generar relaciones (`FOREIGN KEY`) automáticamente en tu archivo.

### 🗄️ Soporte Multi-Dialecto y Conversión Automática
Compatible con los formatos y motores más utilizados:
- **PostgreSQL** (`SERIAL`, `UUID`, `TIMESTAMPTZ`, `CONSTRAINT ... FOREIGN KEY`)
- **MySQL / MariaDB** (`AUTO_INCREMENT`, `ENGINE=InnoDB`, `ENUM`, identificadores con backticks)
- **SQLite** (definiciones `REFERENCES` en línea)
- **DBML / DSL de Bloques** (tablas en bloques `{ ... }` y relaciones rápidas con `> tabla.columna`)

Puedes cambiar el formato desde el selector superior del diagrama para traducir todo tu esquema de un dialecto a otro en un solo clic.

### ⚡ Optimizado para Esquemas Grandes (+100 Tablas)
- **Vista Compacta (`PK/FK`):** Oculta las columnas secundarias en esquemas extensos para mostrar claramente la estructura de llaves y relaciones, permitiendo expandir tablas individuales cuando lo necesites.
- **Modo "Solo Conectadas":** Selecciona cualquier tabla para aislar y visualizar únicamente las tablas directamente relacionadas con ella.
- **Buscador Instantáneo y Auto-Ordenamiento:** Filtra tablas por nombre en vivo y organiza automáticamente el lienzo priorizando las tablas maestras con mayor número de relaciones.

### 👥 Colaboración en Tiempo Real para Equipos
- **Salas Compartidas en Vivo (`Compartir Sala`):** Inicia una sesión colaborativa desde VS Code para que múltiples integrantes del equipo visualicen y editen el mismo diagrama simultáneamente.
- **Acceso desde VS Code o Navegador Web:** Tus compañeros pueden unirse desde su propio VS Code o abriendo el enlace de la sala directamente en su navegador, con cursores en tiempo real e identificación por usuario.

---

## 🚀 Cómo Usarlo

1. Abre cualquier archivo `.sql`, `.ddl`, `.dbml` o `.erd` en VS Code.
2. Haz clic en el botón **"SQL ERD: Abrir Diagrama Visual al Lado"** en la esquina superior derecha del editor (o clic derecho sobre el archivo → **Open With...** → **SQL ERD Visual Diagram**).
3. Interactúa con el lienzo:
   - **Doble clic** sobre el nombre de una tabla, columna o tipo de dato para editarlo.
   - **Arrastra** desde el puerto derecho (azul) de una columna hacia el puerto izquierdo (dorado) de otra tabla para crear una relación `FOREIGN KEY`.
   - **Haz clic** sobre cualquier línea de conexión para eliminar la relación.
