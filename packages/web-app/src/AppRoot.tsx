import { RouterProvider } from "@tanstack/react-router";
import { router } from "@/router";

export default function AppRoot() {
	return <RouterProvider router={router} />;
}
