/** Keep an explicit choice; otherwise start on the most recently created project. */
export function chooseProject<T extends { id: string; createdAt: string }>(
  projects: readonly T[],
  preferredId?: string,
  previousId?: string,
  rememberedId?: string,
): T | undefined {
  for (const id of [preferredId, previousId, rememberedId]) {
    if (!id) continue;
    const match = projects.find((project) => project.id === id);
    if (match) return match;
  }
  return projects.reduce<T | undefined>(
    (latest, project) => (!latest || project.createdAt > latest.createdAt ? project : latest),
    undefined,
  );
}
