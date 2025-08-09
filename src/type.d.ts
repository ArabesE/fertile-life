// Let TypeScript know workers imported via new URL() are modules.
declare module "*?worker" {
  const WorkerFactory: { new (): Worker };
  export default WorkerFactory;
}
