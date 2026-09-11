import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { TagsController } from './tags.controller';
import { TagsService } from './tags.service';
import { AuthModule } from '../auth/auth.module';

@Module({
    imports: [DatabaseModule, AuthModule],
    controllers: [TagsController],
    providers: [TagsService],
    exports: [TagsService],
})
export class TagsModule { }
