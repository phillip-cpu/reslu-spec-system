import { Header } from "@/components/layout/Header";
import { ProjectForm } from "@/components/projects/ProjectForm";

export default function NewProjectPage() {
  return (
    <>
      <Header title="New Project" subtitle="Set up a new RESLU project." />
      <main className="flex-1 px-8 py-8">
        <ProjectForm />
      </main>
    </>
  );
}
