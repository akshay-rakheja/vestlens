import "../../kit/theme.css";
import { render } from "preact";
import { createBridge } from "../../kit/bridge";
import { TfsaRoom } from "./TfsaRoom";

render(<TfsaRoom bridge={createBridge(window, { appName: "portfolio-tfsa-room" })} />, document.getElementById("app")!);
