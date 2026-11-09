import { Controller, Get, Module } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Public } from '../auth/decorators.js';
import { Product } from './product.entity.js';

interface ProductResponse {
  id: string;
  sku: string;
  name: string;
  price: string;
}

@ApiTags('products')
@Controller('products')
export class ProductsController {
  constructor(
    @InjectRepository(Product) private readonly products: Repository<Product>,
  ) {}

  @Public()
  @Get()
  async list(): Promise<ProductResponse[]> {
    const products = await this.products.find({
      where: { active: true },
      order: { name: 'ASC' },
    });
    return products.map(({ id, sku, name, price }) => ({
      id,
      sku,
      name,
      price,
    }));
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([Product])],
  controllers: [ProductsController],
})
export class ProductsModule {}
