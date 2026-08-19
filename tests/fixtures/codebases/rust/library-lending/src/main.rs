use library_lending::{Book, InMemoryLibrary, LendingService, Member};

fn main() {
    let mut library = InMemoryLibrary::new();
    library.add_book(Book::new("book-1", "The Left Hand of Darkness"));
    library.add_member(Member::new("member-1", "Ada"));

    let mut service = LendingService::new(library);
    let loan = service
        .lend_book("book-1", "member-1")
        .expect("the seeded book should be lendable");
    let book = service
        .find_book(&loan.book_id)
        .expect("the lent book should remain in the repository");

    println!("{} lent to Ada", book.title);
}
