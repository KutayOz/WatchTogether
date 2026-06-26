#r "nuget: BCrypt.Net-Next, 4.0.3"

using BCrypt.Net;

var password = "test123";
var hash = BCrypt.Net.BCrypt.HashPassword(password);
Console.WriteLine($"Password: {password}");
Console.WriteLine($"Hash: {hash}");
