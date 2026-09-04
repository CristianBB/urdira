import { Base } from "./base.js";

export class Derived extends Base {
  public greet(): string {
    return `hello ${this.id}`;
  }
}
