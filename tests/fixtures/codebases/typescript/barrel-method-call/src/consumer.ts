import { FooService } from './services';

export class Consumer {
  public constructor(private readonly fooService: FooService) {}

  public run(): number {
    return this.fooService.bar();
  }
}
