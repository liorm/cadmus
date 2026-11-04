export type TaskLike = {
	index: number;
	title: string;
	status: "pending" | "in_progress" | "done";
};

export type TaskProgress = {
	determinate: boolean;
	done: number;
	total: number;
	currentIndex?: number;
	currentTitle?: string;
	ratio: number;
};

export function taskProgress(tasks: TaskLike[] | undefined): TaskProgress {
	if (!tasks || tasks.length === 0) {
		return { determinate: false, done: 0, total: 0, ratio: 0 };
	}
	const done = tasks.filter((task) => task.status === "done").length;
	const current = tasks.find((task) => task.status === "in_progress");
	return {
		determinate: true,
		done,
		total: tasks.length,
		currentIndex: current?.index,
		currentTitle: current?.title,
		ratio: tasks.length === 0 ? 0 : done / tasks.length,
	};
}
