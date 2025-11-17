import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // Strip properties that don't have decorators
      forbidNonWhitelisted: true, // Throw error if extra properties
      transform: true, // Transform payloads to DTO instances
    }),
  );

  // CORS configuration
  app.enableCors({
    origin: configService.get<string>('CORS_ORIGIN') || 'http://localhost:3000',
    credentials: true,
  });

  // API prefix
  const apiPrefix = configService.get<string>('API_PREFIX') || 'api/v1';
  app.setGlobalPrefix(apiPrefix);

  // Swagger documentation
  const config = new DocumentBuilder()
    .setTitle('LDV-Bridge API')
    .setDescription(
      'Low-Code Development Bridge API - Governance platform for PowerApps and Mendix',
    )
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'JWT',
        description: 'Enter JWT token from Auth0',
        in: 'header',
      },
      'JWT-auth', // This name here is important for matching up with @ApiBearerAuth() in your controllers
    )
    .addTag('Authentication', 'Auth0 JWT authentication endpoints')
    .addTag('Users', 'User management')
    .addTag('Organizations', 'Multi-tenant organization management')
    .addTag('Apps', 'Application management')
    .addTag('Changes', 'Change tracking and management')
    .addTag('Reviews', 'Code review workflow')
    .addTag('Deployments', 'CI/CD pipeline management')
    .addTag('Health', 'Health check endpoints')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true, // Keep authorization after page refresh
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
    },
  });

  const port = configService.get<number>('PORT') || 3001;
  await app.listen(port);

  console.log(`
  🚀 LDV-Bridge API is running!
  
  📝 API Documentation: http://localhost:${port}/api/docs
  🔗 API Endpoint: http://localhost:${port}/${apiPrefix}
  💚 Health Check: http://localhost:${port}/health
  🔐 Auth Health: http://localhost:${port}/${apiPrefix}/auth/health
  `);
}
bootstrap();

