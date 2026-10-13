import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./interfaces/http/app.module";

// bootstrap da API HTTP (§9) — o wiring todo mora em interfaces/http/app.module
async function bootstrap(): Promise<void> {
    const app = await NestFactory.create(AppModule);

    // SIGTERM → onApplicationShutdown: conexões fechadas após concluir o andamento
    app.enableShutdownHooks();

    const port = Number(process.env.PORT ?? 3000);
    await app.listen(port);
    console.log(JSON.stringify({ level: "info", event: "listening", port }));
}

void bootstrap();
