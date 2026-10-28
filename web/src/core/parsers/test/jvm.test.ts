import { describe, expect, it } from 'vitest'
import { findEnum, findModel } from '../../model/schema.ts'
import { detectFormat, parseInput } from '../registry.ts'
import { fieldsOf, parseOk } from './helpers.ts'

describe('Java', () => {
  it('reads POJOs, JPA entities, nested classes and enums', () => {
    const { schema } = parseOk(
      `package com.example.shop;

import jakarta.persistence.*;
import java.util.List;

/** A customer of the shop */
@Entity
@Table(name = "customers")
public class CustomerEntity extends BaseEntity {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "full_name", nullable = false)
    private String fullName;

    @JsonProperty("email_address")
    private String email;

    private Integer age;
    private int visits = 0;
    private BigDecimal balance;
    private LocalDateTime createdAt;
    private List<Address> addresses;
    private Map<String, Integer> counters;
    private byte[] avatar;
    private Optional<String> nickname;
    private Status status;
    private static final long serialVersionUID = 1L;
    @Transient
    private String cache;

    public CustomerEntity() {}

    public String getFullName() { return fullName; }

    public static class Address {
        public String city;
    }

    public enum Status { ACTIVE, BLOCKED("blocked") }
}`,
      'java',
    )
    expect(fieldsOf(schema, 'CustomerEntity')).toEqual([
      'id: integer64 | null',
      'fullName: string',
      'email: string',
      'age: integer32 | null',
      'visits: integer32',
      'balance: decimal',
      'createdAt: datetime',
      'addresses: Address[]',
      'counters: map<string, integer32>',
      'avatar: binary',
      'nickname: string | null',
      'status: Status',
    ])
    const customer = findModel(schema, 'CustomerEntity')!
    expect(customer).toMatchObject({
      kind: 'entity',
      framework: 'jpa',
      namespace: 'com.example.shop',
      description: 'A customer of the shop',
    })
    expect(customer.metadata).toMatchObject({ accessors: 'getters' })
    expect(customer.fields[0].generated).toBe(true)
    expect(customer.fields[1].serializedName).toBe('full_name')
    expect(customer.fields[2].serializedName).toBe('email_address')
    expect(findModel(schema, 'Address')!.metadata).toMatchObject({ accessors: 'fields' })
    expect(findEnum(schema, 'Status')!.values).toEqual([{ name: 'ACTIVE' }, { name: 'BLOCKED', value: 'blocked' }])
  })

  it('reads records and Lombok builders', () => {
    const { schema } = parseOk(
      `public record OrderDto(long id, @JsonProperty("customer_name") String customerName, List<OrderLineDto> lines) {}
@Data @Builder
public class OrderLineDto { private String sku; private int quantity; }`,
      'java',
    )
    expect(fieldsOf(schema, 'OrderDto')).toEqual(['id: integer64', 'customerName: string', 'lines: OrderLineDto[]'])
    expect(findModel(schema, 'OrderDto')).toMatchObject({ kind: 'record', construction: 'positional', metadata: { accessors: 'record' } })
    expect(findModel(schema, 'OrderLineDto')!.metadata).toMatchObject({ builder: true, accessors: 'getters' })
  })

  it('reports errors and is detected', () => {
    expect(parseInput('class A { String b = "x; }', 'java')).toMatchObject({ ok: false, error: { code: 'unterminatedString' } })
    expect(detectFormat('package a.b;\npublic class A {}')).toBe('java')
    expect(detectFormat('public class User {\n  private String name;\n}')).toBe('java')
  })
})

describe('C#', () => {
  it('reads classes with properties, attributes and nullable types', () => {
    const { schema } = parseOk(
      `using System.ComponentModel.DataAnnotations;
namespace Shop.Models;

/// <summary>A product in the catalog</summary>
[Table("Products")]
public class Product
{
    [Key]
    [DatabaseGenerated(DatabaseGeneratedOption.Identity)]
    public int Id { get; set; }

    [Required]
    [JsonPropertyName("product_name")]
    public string Name { get; set; } = null!;

    public string? Description { get; set; }
    public decimal Price { get; init; }
    public int? Stock { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public Guid ExternalId { get; set; }
    public byte[] Image { get; set; }
    public virtual ICollection<Review> Reviews { get; set; } = new List<Review>();
    public string Label => $"{Name} ({Price})";
    public int Total { get { return 1; } }
    [NotMapped]
    public string Temp { get; set; }
    private readonly int _cache;
    public Product() { }
    public void Save() { }
}

public record Review(int Id, string Text, int Rating = 5);

public enum Category { Food, Books = 4, Toys }`,
      'csharp',
    )
    expect(fieldsOf(schema, 'Product')).toEqual([
      'Id: integer32',
      'Name: string',
      'Description: string | null',
      'Price: decimal',
      'Stock: integer32 | null',
      'CreatedAt?: datetime',
      'ExternalId: uuid',
      'Image: binary',
      'Reviews?: Review[]',
    ])
    const product = findModel(schema, 'Product')!
    expect(product).toMatchObject({
      kind: 'entity',
      framework: 'efcore',
      namespace: 'Shop.Models',
      description: 'A product in the catalog',
    })
    expect(product.fields[0].generated).toBe(true)
    expect(product.fields[1].serializedName).toBe('product_name')
    expect(fieldsOf(schema, 'Review')).toEqual(['Id: integer32', 'Text: string', 'Rating?: integer32'])
    expect(findModel(schema, 'Review')!.construction).toBe('positional')
    expect(findEnum(schema, 'Category')!.values).toEqual([
      { name: 'Food', value: 0 },
      { name: 'Books', value: 4 },
      { name: 'Toys', value: 5 },
    ])
  })

  it('skips DbContext and is detected', () => {
    const { schema } = parseOk(
      'public class AppDb : DbContext { public DbSet<User> Users { get; set; } }\npublic class User { public int Id { get; set; } }',
      'csharp',
    )
    expect(schema.models.map((model) => model.name)).toEqual(['User'])
    expect(detectFormat('public class A { public int B { get; set; } }')).toBe('csharp')
  })
})

describe('Kotlin', () => {
  it('reads data classes, body properties and enums', () => {
    const { schema } = parseOk(
      `package com.example.api

import kotlinx.serialization.SerialName

/** A user as the API returns it */
@Serializable
data class UserDto(
    val id: Long,
    @SerialName("first_name") val firstName: String,
    val lastName: String? = null,
    val roles: List<String> = emptyList(),
    val status: Status,
    private val secret: String,
    notAProperty: Int,
) {
    val fullName: String get() = "$firstName $lastName"
    var visits: Int = 0
    fun greet() = "Hi"
    companion object { const val VERSION = 1 }
}

enum class Status(val code: String) { ACTIVE("A"), BLOCKED("B") }`,
      'kotlin',
    )
    expect(fieldsOf(schema, 'UserDto')).toEqual([
      'id: integer64',
      'firstName: string',
      'lastName?: string | null',
      'roles?: string[]',
      'status: Status',
      'visits: integer32',
    ])
    const user = findModel(schema, 'UserDto')!
    expect(user).toMatchObject({
      kind: 'record',
      construction: 'named',
      namespace: 'com.example.api',
      description: 'A user as the API returns it',
    })
    expect(user.fields[1].serializedName).toBe('first_name')
    expect(findEnum(schema, 'Status')!.values).toEqual([
      { name: 'ACTIVE', value: 'A' },
      { name: 'BLOCKED', value: 'B' },
    ])
  })

  it('is detected', () => {
    expect(detectFormat('data class A(val b: String)')).toBe('kotlin')
    expect(parseInput('class A(val b: String = "x)', 'kotlin')).toMatchObject({ ok: false, error: { code: 'unterminatedString' } })
  })
})
