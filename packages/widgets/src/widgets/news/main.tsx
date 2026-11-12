import "../../kit/theme.css";
import { render } from "preact";
import { createBridge } from "../../kit/bridge";
import { News } from "./News";

render(<News bridge={createBridge(window, { appName: "portfolio-news" })} />, document.getElementById("app")!);
